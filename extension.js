import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as AnimationUtils from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ServiceClient} from './serviceClient.js';
import {Keyboard} from './keyboard.js';
import {DialogManager} from './confirmDialog.js';
import {placePopup} from './placement.js';

const TYPE = St.ClipboardType.CLIPBOARD;
const PAGE = 30;

export default class ClipboardArchive extends Extension {
    enable() {
        this.settings = this.getSettings();
        this.dead = false;
        this.generation = 0;
        this.sources = new Set();
        this.bindings = [];
        this.rows = [];
        this.offset = 0;
        this.selected = 0;
        this.client = new ServiceClient(this.path, this.uuid);
        this.keyboard = new Keyboard();
        this.dialogs = new DialogManager();
        this.clipboard = St.Clipboard.get_default();
        this.button = new PanelMenu.Button(0.0, 'Clipboard archive');
        this.button.add_child(new St.Icon({icon_name:'edit-paste-symbolic', style_class:'system-status-icon'}));
        Main.panel.addToStatusArea('clipboardArchive', this.button);
        this.buildSettingsMenu();
        this.buildHistory();
        this.bindShortcuts();
        this.settingsId = this.settings.connect('changed', () => {
            this.bindShortcuts();
            this.privateSwitch.setToggleState(this.settings.get_boolean('private-mode'));
            this.imagesSwitch.setToggleState(this.settings.get_boolean('cache-images'));
        });
        this.caretId = Main.inputMethod.connect('cursor-location-changed', (_, rect) => {
            if (this.history.isOpen) return;
            this.caret = {x:rect.origin.x, y:rect.origin.y + rect.size.height,
                window:global.display.focus_window};
        });
        this.focusId = global.display.connect('notify::focus-window', () => { this.caret = null; });
        this.selection = global.display.get_selection();
        this.selectionId = this.selection.connect('owner-changed', (_, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD) this.capture();
        });
        // Import before optional explicit clear-on-boot, and keep the old cache intact.
        this.run(async () => {
            await this.client.request('stats');
            if (this.settings.get_boolean('clear-on-boot')) await this.client.request('clear');
        });
        this.configureInterval();
    }

    run(action) {
        Promise.resolve().then(action).catch(error => {
            if (!this.dead) {
                console.error(`Clipboard archive: ${error.message}`);
                if (this.status) this.status.text = error.message;
            }
        });
    }

    later(ms, action) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this.sources.delete(id);
            if (!this.dead) action();
            return GLib.SOURCE_REMOVE;
        });
        this.sources.add(id);
        return id;
    }

    buildSettingsMenu() {
        this.privateSwitch = new PopupMenu.PopupSwitchMenuItem('Private mode', this.settings.get_boolean('private-mode'));
        this.privateSwitch.connect('toggled', (_, value) => this.settings.set_boolean('private-mode', value));
        this.button.menu.addMenuItem(this.privateSwitch);
        const images = this.imagesSwitch = new PopupMenu.PopupSwitchMenuItem('Capture images', this.settings.get_boolean('cache-images'));
        images.connect('toggled', (_, value) => this.settings.set_boolean('cache-images', value));
        this.button.menu.addMenuItem(images);
        this.button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.archiveInfo = new PopupMenu.PopupMenuItem('Archive loading…', {reactive:false});
        this.button.menu.addMenuItem(this.archiveInfo);
        this.button.menu.addAction('Open history', () => this.later(0, () => this.openHistory()));
        this.button.menu.addAction('Clear unpinned history…', () => this.clear());
        this.button.menu.addAction('Preferences', () => this.openPreferences());
        this.button.menu.connect('open-state-changed', (_, open) => {
            if (open) this.run(async () => {
                const s = await this.client.request('stats');
                if (!this.dead) this.archiveInfo.label.text = `${s.count} items · ${(s.bytes/1048576).toFixed(1)} MB · Search: ${s.semantic}`;
            });
        });
    }

    buildHistory() {
        this.anchor = new St.Widget({width:1, height:1, opacity:0});
        Main.uiGroup.add_child(this.anchor);
        this.history = new PopupMenu.PopupMenu(this.anchor, 0, St.Side.TOP);
        this.history.actor.add_style_class_name('ci-floating-history');
        Main.uiGroup.add_child(this.history.actor);
        this.history.actor.hide();
        this.manager = new PopupMenu.PopupMenuManager(this.button);
        this.manager.addMenu(this.history);
        const searchRow = new PopupMenu.PopupBaseMenuItem({reactive:false, can_focus:false});
        this.search = new St.Entry({hint_text:'Search clipboard history…', can_focus:true, x_expand:true,
            primary_icon:new St.Icon({icon_name:'edit-find-symbolic'})});
        searchRow.add_child(this.search);
        this.history.addMenuItem(searchRow);
        this.search.clutter_text.connect('text-changed', () => {
            this.generation++;
            if (this.searchTimer) { GLib.source_remove(this.searchTimer); this.sources.delete(this.searchTimer); }
            this.searchTimer = this.later(100, () => {
                this.searchTimer = null;
                this.offset = 0;
                this.refresh();
            });
        });
        this.results = new PopupMenu.PopupMenuSection();
        const scrollRow = new PopupMenu.PopupBaseMenuItem({reactive:false, can_focus:false});
        this.scroll = new St.ScrollView({style_class:'ci-archive-scroll', overlay_scrollbars:true, x_expand:true});
        this.scroll.add_child(this.results.actor);
        scrollRow.add_child(this.scroll);
        this.history.addMenuItem(scrollRow);
        this.status = new St.Label({text:'', style_class:'ci-archive-status'});
        const statusRow = new PopupMenu.PopupBaseMenuItem({reactive:false, can_focus:false});
        statusRow.add_child(this.status);
        this.history.addMenuItem(statusRow);
        const pages = new PopupMenu.PopupBaseMenuItem({reactive:false, can_focus:false});
        this.previous = this.smallButton('Previous page', () => { this.offset = Math.max(0,this.offset-PAGE); this.refresh(); });
        this.next = this.smallButton('Next page', () => { this.offset += PAGE; this.refresh(); });
        pages.add_child(this.previous); pages.add_child(this.next);
        this.history.addMenuItem(pages);
        this.history.actor.connect('key-press-event', (_, event) => this.key(event));
        this.history.connect('open-state-changed', (_, open) => {
            if (!open) this.generation++;
        });
    }

    smallButton(label, action) {
        const b = new St.Button({label, style_class:'ci-archive-action', can_focus:true});
        b.connect('clicked', () => this.run(action));
        return b;
    }

    openHistory() {
        if (this.history.isOpen) { this.history.close(); return; }
        this.button.menu.close();
        this.offset = 0;
        this.search.text = '';
        const pointer = global.get_pointer();
        const caret = this.settings.get_boolean('prefer-caret') && this.caret?.window === global.display.focus_window ? this.caret : null;
        const [x,y] = caret ? [caret.x,caret.y] : pointer;
        const monitors = Main.layoutManager.monitors;
        const monitor = monitors.find(m => x>=m.x && x<m.x+m.width && y>=m.y && y<m.y+m.height) || Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const placement = placePopup(x,y,area,460,440,12);
        this.anchor.set_position(placement.x,placement.y);
        this.history.box.set_style(`width: ${placement.width}px;`);
        this.scroll.set_style(`max-height: ${Math.max(40,placement.height-210)}px;`);
        this.history._boxPointer.updateArrowSide(placement.above ? St.Side.BOTTOM : St.Side.TOP);
        this.history.open();
        global.stage.set_key_focus(this.search);
        this.refresh();
    }

    refresh() {
        if (this.queryBusy) { this.queryAgain=true; return; }
        this.queryBusy=true;
        const token = ++this.generation;
        const q = this.search.text;
        this.status.text = 'Searching…';
        // Lexical results appear first even while an embedding query is expensive.
        this.run(async () => {
            try {
            const reply = await this.client.request('query',{q,offset:this.offset,limit:PAGE});
            if (this.dead || token !== this.generation || !this.history.isOpen) return;
            this.render(reply);
            if (q && this.offset === 0 && this.settings.get_boolean('semantic-search')) {
                const hybrid = await this.client.request('query',{q,limit:PAGE,semantic:true});
                if (!this.dead && token === this.generation && this.history.isOpen) this.render(hybrid);
            }
            } finally {
                this.queryBusy=false;
                if (this.queryAgain && !this.dead && this.history.isOpen) {
                    this.queryAgain=false;
                    this.refresh();
                }
            }
        });
    }

    render(reply) {
        this.results.removeAll();
        this.rows = reply.items;
        this.rowActors = [];
        this.actionActors = [];
        this.selected = 0;
        for (const [index,entry] of this.rows.entries()) {
            const label = entry.mimetype.startsWith('image/') ? 'Image' : entry.preview.replace(/\s+/g,' ');
            const item = new PopupMenu.PopupMenuItem(`${entry.favorite ? '★ ' : ''}${label || '(empty text)'}`);
            item.label.clutter_text.set_ellipsize(3);
            item.label.x_expand = true;
            if (entry.thumbnail) item.insert_child_at_index(new St.Icon({gicon:Gio.icon_new_for_string(entry.thumbnail),icon_size:32}),1);
            if (entry.tag) item.add_child(new St.Label({text:entry.tag.slice(0,32),style_class:'ci-tag-label'}));
            item.connect('activate', () => this.run(() => this.select(entry)));
            item.track_hover=true;
            const active = () => this.setActive(index);
            item.connect('key-focus-in', () => { active(); AnimationUtils.ensureActorVisibleInScrollView(this.scroll,item); });
            item.connect('notify::hover', () => { if(item.hover) active(); });
            const actions=new St.BoxLayout({style_class:'ci-row-actions',visible:index===0});
            const action=(icon,label,callback) => {
                const button=new St.Button({can_focus:true,style_class:'ci-row-action',accessible_name:label,
                    child:new St.Icon({icon_name:icon,icon_size:16})});
                button.connect('clicked',() => this.run(callback));
                button.connect('key-focus-in',active);
                actions.add_child(button);
            };
            if(entry.mimetype.startsWith('image/')) action('view-reveal-symbolic','Preview image',async () => {
                const result=await this.client.request('file',{entry:entry.id});
                this.history.close();
                Gio.AppInfo.launch_default_for_uri_async(result.uri,null,null,(_,res) => {
                    try { Gio.AppInfo.launch_default_for_uri_finish(res); } catch(error) { console.error(error.message); }
                });
            });
            else action('document-edit-symbolic','Edit',() => this.edit(entry,false));
            action(entry.favorite?'view-pin-symbolic':'list-add-symbolic',entry.favorite?'Unpin':'Pin',async () => {
                await this.client.request('update',{entry:entry.id,favorite:!entry.favorite}); this.refresh();
            });
            action('bookmark-new-symbolic','Tag',() => this.edit(entry,true));
            action('edit-delete-symbolic','Delete',() => this.deleteEntry(entry));
            item.add_child(actions);
            this.actionActors.push(actions);
            this.results.addMenuItem(item);
            this.rowActors.push(item);
        }
        this.previous.reactive = this.offset>0;
        this.previous.opacity = this.offset>0 ? 255:80;
        this.next.reactive = reply.more;
        this.next.opacity = reply.more ? 255:80;
        this.status.text = this.rows.length ? `${this.offset+1}–${this.offset+this.rows.length} · ${reply.semantic} · Ctrl+P pin · Ctrl+T tag · Ctrl+E edit` : 'No matching items';
    }

    setActive(index) {
        this.selected=index;
        this.actionActors?.forEach((actor,i) => { actor.visible=i===index; });
    }

    key(event) {
        const key = event.get_key_symbol();
        const control = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const entry = this.rows[this.selected];
        if (key === Clutter.KEY_Escape) { this.history.close(); return Clutter.EVENT_STOP; }
        if (key === Clutter.KEY_Down || key === Clutter.KEY_Up) {
            const atSearch = global.stage.key_focus === this.search.clutter_text;
            this.selected = atSearch ? 0 : Math.max(0,Math.min(this.rows.length-1,this.selected+(key===Clutter.KEY_Down?1:-1)));
            this.rowActors[this.selected]?.grab_key_focus();
            return Clutter.EVENT_STOP;
        }
        if (entry && key === Clutter.KEY_Return && global.stage.key_focus === this.search.clutter_text) { this.run(() => this.select(entry)); return Clutter.EVENT_STOP; }
        if (entry && control && key === Clutter.KEY_p) {
            this.run(async () => { await this.client.request('update',{entry:entry.id,favorite:!entry.favorite}); this.refresh(); });
            return Clutter.EVENT_STOP;
        }
        if (entry && control && key === Clutter.KEY_t) { this.edit(entry,true); return Clutter.EVENT_STOP; }
        if (entry && control && key === Clutter.KEY_e) { this.edit(entry,false); return Clutter.EVENT_STOP; }
        if (entry && control && key === Clutter.KEY_Delete) {
            this.deleteEntry(entry);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    deleteEntry(entry) {
        const remove = () => this.run(async () => {
            await this.client.request('delete',{entry:entry.id});
            if (this.history.isOpen) this.refresh();
        });
        if (entry.favorite) {
            this.history.close();
            this.dialogs.open('Delete pinned item?','','','Delete','Cancel',remove);
        } else remove();
    }

    edit(entry, tag) {
        this.run(async () => {
            if (!tag && entry.mimetype.startsWith('image/')) return;
            const payload = tag ? null : await this.client.request('get',{entry:entry.id});
            if (this.dead) return;
            this.history.close();
            this.editor = new ModalDialog.ModalDialog();
            const input = new St.Entry({text:tag ? entry.tag : new TextDecoder().decode(GLib.base64_decode(payload.data)),
                can_focus:true, style_class:'ci-edit-textbox'});
            this.editor.contentLayout.add_child(new St.Label({text:tag ? 'Edit tag' : 'Edit clipboard text'}));
            this.editor.contentLayout.add_child(input);
            const dialog = this.editor;
            dialog.setButtons([{label:'Cancel',key:Clutter.KEY_Escape,action:() => dialog.close()},
                {label:'Save',action:() => {
                    const value=input.text;
                    dialog.close();
                    this.run(async () => { await this.client.request('update',{entry:entry.id,...(tag?{tag:value}:{text:value})}); });
                }}]);
            dialog.setInitialKeyFocus(input);
            dialog.open();
        });
    }

    async select(entry, paste = true) {
        const payload = await this.client.request('get',{entry:entry.id});
        if (this.dead) return;
        this.history.close();
        this.currentId=entry.id;
        this.skipCapture = true;
        this.clipboard.set_content(TYPE,payload.mimetype,new GLib.Bytes(GLib.base64_decode(payload.data)));
        this.later(80, () => {
            if (paste && this.settings.get_boolean('paste-on-select')) {
                const terminal = this.keyboard.purpose === Clutter.InputContentPurpose.TERMINAL;
                if (terminal) this.keyboard.press(Clutter.KEY_Control_L);
                this.keyboard.press(Clutter.KEY_Shift_L); this.keyboard.press(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Insert); this.keyboard.release(Clutter.KEY_Shift_L);
                if (terminal) this.keyboard.release(Clutter.KEY_Control_L);
            }
            this.later(80, () => { this.skipCapture=false; });
        });
    }

    async capture() {
        if (this.dead || this.skipCapture || this.settings.get_boolean('private-mode')) return;
        const window = global.display.focus_window;
        if (this.settings.get_strv('excluded-apps').includes(window?.get_wm_class())) return;
        const generation = this.captureGeneration = (this.captureGeneration || 0)+1;
        const types = ['text/plain;charset=utf-8','UTF8_STRING','text/plain','STRING',
            ...(this.settings.get_boolean('cache-images')?['image/png','image/jpeg','image/webp','image/gif']:[]),'text/html'];
        try {
            for (let mimetype of types) {
                const bytes = await new Promise(resolve => this.clipboard.get_content(TYPE,mimetype,(_,data) => resolve(data)));
                if (this.dead || generation !== this.captureGeneration || this.settings.get_boolean('private-mode')) return;
                if (!bytes?.get_size()) continue;
                if (mimetype==='UTF8_STRING' || mimetype==='STRING') mimetype='text/plain;charset=utf-8';
                await this.client.request('add',{mimetype,data:GLib.base64_encode(bytes.get_data())});
                if (this.history.isOpen) this.refresh();
                break;
            }
        } catch (error) { if (!this.dead) console.error(`Clipboard capture: ${error.message}`); }
    }

    clear() {
        this.history.close();
        this.dialogs.open('Clear unpinned history?', 'Pinned entries will be kept.', '', 'Clear','Cancel',
            () => this.run(() => this.client.request('clear')));
    }

    configureInterval() {
        // Existing opt-in cleanup remains supported. Unlimited retention is the default.
        this.interval = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,60,() => {
            if (this.dead) return GLib.SOURCE_REMOVE;
            if (this.settings.get_boolean('clear-history-on-interval')) {
                const now=Date.now();
                this.lastClear ??=now;
                if (now-this.lastClear >= this.settings.get_int('clear-history-interval')*60000) {
                    this.lastClear=now;
                    this.run(() => this.client.request('clear'));
                }
            } else this.lastClear=null;
            return GLib.SOURCE_CONTINUE;
        });
    }

    cycle(direction) {
        this.run(async () => {
            const entry=await this.client.request('cycle',{entry:this.currentId,direction});
            if (entry) await this.select(entry,false);
        });
    }

    bindShortcuts() {
        for (const key of this.bindings) Main.wm.removeKeybinding(key);
        this.bindings=[];
        if (!this.settings.get_boolean('enable-keybindings')) return;
        const callbacks = {
            'toggle-menu':() => this.openHistory(), 'clear-history':() => this.clear(),
            'prev-entry':() => this.cycle(-1), 'next-entry':() => this.cycle(1),
            'private-mode-binding':() => this.settings.set_boolean('private-mode',!this.settings.get_boolean('private-mode')),
        };
        for (const [key,callback] of Object.entries(callbacks)) {
            Main.wm.addKeybinding(key,this.settings,Meta.KeyBindingFlags.NONE,Shell.ActionMode.NORMAL,callback);
            this.bindings.push(key);
        }
    }

    disable() {
        if (this.dead) return;
        this.dead=true;
        this.generation++;
        this.captureGeneration++;
        for (const key of this.bindings) Main.wm.removeKeybinding(key);
        for (const id of this.sources) GLib.source_remove(id);
        GLib.source_remove(this.interval);
        this.settings.disconnect(this.settingsId);
        Main.inputMethod.disconnect(this.caretId);
        global.display.disconnect(this.focusId);
        this.selection.disconnect(this.selectionId);
        this.editor?.destroy();
        this.dialogs.destroy();
        this.keyboard.destroy();
        this.history.destroy();
        this.anchor.destroy();
        this.button.destroy();
        this.client.destroy();
    }
}
