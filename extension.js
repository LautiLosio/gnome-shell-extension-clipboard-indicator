import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
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
import {getSearchMode, SEARCH_MODES} from './searchMode.js';

const TYPE = St.ClipboardType.CLIPBOARD;
const PAGE = 60;
const OVERSCAN = 15;

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
        this.panelBox=new St.BoxLayout({style_class:'panel-status-menu-box'});
        this.panelIcon=new St.Icon({icon_name:'edit-paste-symbolic',style_class:'system-status-icon'});
        this.panelLabel=new St.Label({text:'Clipboard',y_align:Clutter.ActorAlign.CENTER});
        this.panelArrow=PopupMenu.arrowIcon(St.Side.BOTTOM);
        this.panelBox.add_child(this.panelIcon);this.panelBox.add_child(this.panelLabel);this.panelBox.add_child(this.panelArrow);
        this.button.add_child(this.panelBox);
        Main.panel.addToStatusArea('clipboardArchive', this.button);
        this.buildSettingsMenu();
        this.buildHistory();
        this.previewBox=new St.BoxLayout({vertical:true,reactive:false,style_class:'popup-menu-content ci-hover-preview',visible:false});
        Main.uiGroup.add_child(this.previewBox);
        this.bindShortcuts();
        this.settingsId = this.settings.connect('changed', () => {
            this.bindShortcuts();
            this.privateSwitch.setToggleState(this.settings.get_boolean('private-mode'));
            this.imagesSwitch.setToggleState(this.settings.get_boolean('cache-images'));
            this.applySettings();
            this.hidePreview();
            if(this.history.isOpen) { this.semanticMode=false; this.refresh(); }
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
        this.applySettings();
        this.configureInterval();
    }

    run(action) {
        Promise.resolve().then(action).catch(error => {
            if (!this.dead) {
                console.error(`Clipboard archive: ${error.message}`);
                if (this.status) { this.status.text = error.message; this.statusRow?.show(); }
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
        this.storageMenu=new PopupMenu.PopupSubMenuMenuItem('Storage');
        this.storageRows={};
        for(const [key,label] of [['semantic','Semantic model'],['content_bytes','Saved content'],['database_bytes','Database and journals'],['attachment_bytes','Attachments and previews'],['runtime_bytes','Search runtime'],['model_bytes','Search models']]) {
            const row=new PopupMenu.PopupMenuItem(label,{reactive:false});
            this.storageRows[key]={row,label};this.storageMenu.menu.addMenuItem(row);
        }
        this.storageMenu.menu.addMenuItem(new PopupMenu.PopupMenuItem('SQLite reuses freed space after deletions.',{reactive:false}));
        this.button.menu.addMenuItem(this.storageMenu);
        this.button.menu.addAction('Open history', () => this.later(0, () => this.openHistory()));
        this.clearAction=this.button.menu.addAction('Clear unpinned history…', () => this.clear());
        this.preferencesAction=this.button.menu.addAction('Preferences', () => this.openPreferences());
        this.button.menu.connect('open-state-changed', (_, open) => {
            if (open) this.run(async () => {
                const s = await this.client.request('stats');
                if (!this.dead) {
                    this.archiveInfo.label.text = `${s.count} ${s.count===1?'item':'items'} · ${GLib.format_size_full(s.content_bytes,GLib.FormatSizeFlags.IEC_UNITS)} content · ${SEARCH_MODES[getSearchMode(this.settings)]}`;
                    for(const [key,{row,label}] of Object.entries(this.storageRows)) row.label.text=`${label}: ${key==='semantic' ? s.semantic : GLib.format_size_full(s[key],GLib.FormatSizeFlags.IEC_UNITS)}`;
                }
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
        const searchRow = this.searchRow = new PopupMenu.PopupBaseMenuItem({reactive:false, can_focus:false});
        this.search = new St.Entry({hint_text:'Search clipboard history…', style_class:'ci-search-entry', can_focus:true, x_expand:true,
            primary_icon:new St.Icon({icon_name:'edit-find-symbolic'})});
        searchRow.add_child(this.search);
        this.history.addMenuItem(searchRow);
        this.search.clutter_text.connect('text-changed', () => {
            this.generation++;
            if (this.searchTimer) { GLib.source_remove(this.searchTimer); this.sources.delete(this.searchTimer); }
            this.searchTimer = this.later(100, () => {
                this.searchTimer = null;
                this.offset = 0;
                this.semanticMode=false;
                this.refresh();
            });
        });
        this.results = new PopupMenu.PopupMenuSection();
        this.results.actor.set_style('spacing: 0;');
        // A non-activatable PopupBaseMenuItem is insensitive and disables its
        // descendants. Use a section so result rows keep normal theme colors.
        const scrollRow = new PopupMenu.PopupMenuSection();
        this.scroll = new St.ScrollView({style_class:'ci-archive-scroll', overlay_scrollbars:true, x_expand:true});
        this.scroll.add_child(this.results.actor);
        scrollRow.actor.add_child(this.scroll);
        this.history.addMenuItem(scrollRow);
        this.adjustment = this.scroll.get_vadjustment();
        this.adjustment.connect('notify::value', () => this.onScroll());
        this.status = new St.Label({text:''});
        const statusRow = this.statusRow = new PopupMenu.PopupBaseMenuItem({reactive:false, can_focus:false});
        statusRow.add_child(this.status);
        this.history.addMenuItem(statusRow);
        this.history.actor.connect('key-press-event', (_, event) => this.key(event));
        this.history.connect('open-state-changed', (_, open) => {
            if (!open) { this.generation++; this.hidePreview(); }
        });
    }

    openHistory() {
        if (this.history.isOpen) { this.history.close(); return; }
        this.button.menu.close();
        this.offset = 0;
        this.semanticMode=false;
        this.search.text = '';
        const pointer = global.get_pointer();
        const caret = this.settings.get_boolean('prefer-caret') && this.caret?.window === global.display.focus_window ? this.caret : null;
        const [x,y] = caret ? [caret.x,caret.y] : pointer;
        const monitors = Main.layoutManager.monitors;
        const monitor = monitors.find(m => x>=m.x && x<m.x+m.width && y>=m.y && y<m.y+m.height) || Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const desktop = new Gio.Settings({schema_id:'org.gnome.desktop.interface'});
        const fontScale = desktop.get_double('text-scaling-factor');
        const placement = placePopup(x,y,area,this.settings.get_int('popup-width')*fontScale,this.settings.get_int('popup-height')*fontScale,this.settings.get_int('popup-margin'));
        this.anchor.set_position(placement.x,placement.y);
        this.history.box.set_style(`width: ${placement.width}px;`);
        this.scroll.set_style(`max-height: ${Math.max(40,placement.height-100*fontScale)}px;`);
        this.history._boxPointer.updateArrowSide(placement.above ? St.Side.BOTTOM : St.Side.TOP);
        this.history.open();
        if(this.settings.get_boolean('show-search-bar')) global.stage.set_key_focus(this.search);
        this.refresh();
    }

    refresh(reset = true) {
        if (reset) {
            this.offset=0;
            this.pendingFocus=null;
            this.rendering=true;
            this.adjustment.value=0;
            this.rendering=false;
        }
        this.generation++;
        if (this.queryBusy) { this.queryAgain=true; return; }
        this.queryBusy=true;
        const token = this.generation;
        const q = this.search.text;
        if (!this.rows.length) { this.statusRow.show(); this.status.text = 'Loading…'; }
        // Lexical results appear first even while an embedding query is expensive.
        this.run(async () => {
            try {
            const reply = await this.client.request('query',{q,offset:this.offset,limit:PAGE,semantic:this.semanticMode || false,...this.searchOptions()});
            if (this.dead || token !== this.generation || !this.history.isOpen) return;
            this.render(reply,reset);
            if (q && this.offset === 0 && getSearchMode(this.settings)===1 && !this.semanticMode) {
                const hybrid = await this.client.request('query',{q,limit:PAGE,semantic:true,...this.searchOptions()});
                if (!this.dead && token === this.generation && this.history.isOpen) { this.semanticMode=true; this.render(hybrid,true); }
            }
            } finally {
                this.queryBusy=false;
                if (this.queryAgain && !this.dead && this.history.isOpen) {
                    this.queryAgain=false;
                    this.refresh(false);
                }
            }
        });
    }

    render(reply,reset = false) {
        this.hidePreview();
        this.rendering=true;
        const oldFocus=global.stage.key_focus;
        const focus=this.pendingFocus ?? (oldFocus && this.rowActors?.some(a=>a.contains(oldFocus)) ? this.renderOffset+this.selected : null);
        const scrollValue=reset ? 0 : this.adjustment.value;
        this.total=reply.total;
        this.results.removeAll();
        this.topSpace=new PopupMenu.PopupBaseMenuItem({reactive:false,can_focus:false});
        this.topSpace.set_style('padding: 0; margin: 0; min-height: 0;');
        this.results.addMenuItem(this.topSpace);
        this.rows = reply.items;
        this.rowActors = [];
        this.actionActors = [];
        this.selected = focus === null ? 0 : Math.max(0,Math.min(this.rows.length-1,focus-this.offset));
        for (const [index,entry] of this.rows.entries()) {
            const label = entry.mimetype.startsWith('image/') ? 'Image' : [...entry.preview.replace(/\s+/g,' ')].slice(0,this.settings.get_int('preview-size')).join('');
            const item = new PopupMenu.PopupMenuItem(label || '(empty text)');
            item.add_style_class_name('ci-history-row');
            if (entry.favorite) item.insert_child_at_index(new St.Icon({icon_name:'view-pin-symbolic',style_class:'popup-menu-icon ci-pin-indicator',accessible_name:'Pinned'}),1);
            item.label.clutter_text.set_ellipsize(3);
            item.label.x_expand = true;
            if (entry.thumbnail) item.insert_child_at_index(new St.Icon({gicon:Gio.icon_new_for_string(entry.thumbnail),style_class:'ci-thumbnail'}),1);
            if (entry.tag) item.add_child(new St.Label({text:entry.tag.slice(0,32),style_class:'ci-entry-tag'}));
            item.connect('activate', () => this.run(() => this.select(entry)));
            item.track_hover=true;
            const active = () => this.setActive(index);
            item.connect('key-focus-in', () => { active(); AnimationUtils.ensureActorVisibleInScrollView(this.scroll,item); });
            item.connect('notify::hover', () => { if(item.hover) active(); else if(!item.contains(global.stage.key_focus)) this.hidePreview(); });
            const actions=new St.BoxLayout({style_class:'ci-row-actions',visible:index===this.selected,y_align:Clutter.ActorAlign.CENTER});
            const action=(icon,label,callback,checked=false,key=null) => {
                if(key && !this.settings.get_boolean(key)) return;
                const button=new St.Button({can_focus:true,style_class:'button flat ci-row-action',accessible_name:label,y_align:Clutter.ActorAlign.CENTER,
                    child:new St.Icon({icon_name:icon,style_class:'ci-action-icon'})});
                if (checked) button.add_style_pseudo_class('checked');
                button.connect('clicked',() => this.run(callback));
                button.connect('key-focus-in',active);
                actions.add_child(button);
            };
            if(entry.mimetype.startsWith('image/') && this.settings.get_boolean('show-preview-button')) action('view-reveal-symbolic','Open image in viewer',async () => {
                const result=await this.client.request('file',{entry:entry.id});
                this.history.close();
                Gio.AppInfo.launch_default_for_uri_async(result.uri,null,null,(_,res) => {
                    try { Gio.AppInfo.launch_default_for_uri_finish(res); } catch(error) { console.error(error.message); }
                });
            });
            else if(!entry.mimetype.startsWith('image/') && this.settings.get_boolean('show-edit-button')) action('document-edit-symbolic','Edit',() => this.edit(entry,false));
            action('view-pin-symbolic',entry.favorite?'Unpin':'Pin',async () => {
                await this.client.request('update',{entry:entry.id,favorite:!entry.favorite}); this.semanticMode=false; this.refresh();
            },entry.favorite,'show-pin-button');
            action('bookmark-new-symbolic','Tag',() => this.edit(entry,true),false,'show-tag-button');
            if(this.settings.get_boolean('enable-deletion')) action('edit-delete-symbolic','Delete',() => this.deleteEntry(entry),false,'show-delete-button');
            action('edit-paste-symbolic','Paste',() => this.select(entry,true,true),false,'paste-button');
            item.add_child(actions);
            this.actionActors.push(actions);
            this.results.addMenuItem(item);
            this.rowActors.push(item);
        }
        this.bottomSpace=new PopupMenu.PopupBaseMenuItem({reactive:false,can_focus:false});
        this.bottomSpace.set_style('padding: 0; margin: 0; min-height: 0;');
        this.results.addMenuItem(this.bottomSpace);
        const first=this.rowActors[0];
        if(first) this.rowHeight=first.get_preferred_height(-1)[1];
        this.rowHeight=Math.max(1,this.rowHeight || 40);
        for(const actor of this.rowActors) actor.height=this.rowHeight;
        this.topSpace.height=this.offset*this.rowHeight;
        this.bottomSpace.height=Math.max(0,this.total-this.offset-this.rows.length)*this.rowHeight;
        this.renderOffset=this.offset;
        this.statusRow.visible=!this.rows.length;
        this.status.text=this.rows.length ? '' : 'No matching items';
        this.rendering=false;
        this.later(0,() => {
            if (!this.history.isOpen) return;
            this.rendering=true;
            this.adjustment.value=scrollValue;
            this.rendering=false;
            if(focus !== null && focus !== undefined) {
                this.pendingFocus=null;
                this.rowActors[focus-this.renderOffset]?.grab_key_focus();
            }
        });
    }

    onScroll() {
        this.hidePreview();
        if(this.rendering || !this.history.isOpen || !this.total || !this.rowHeight) return;
        const first=Math.floor(this.adjustment.value/this.rowHeight);
        const visible=Math.ceil(this.adjustment.page_size/this.rowHeight);
        if(first >= this.renderOffset+OVERSCAN && first+visible < this.renderOffset+this.rows.length-OVERSCAN) return;
        const offset=Math.max(0,Math.min(Math.max(0,this.total-PAGE),Math.floor((first-OVERSCAN)/OVERSCAN)*OVERSCAN));
        if(offset===this.offset) return;
        this.offset=offset;
        this.refresh(false);
    }

    setActive(index) {
        this.selected=index;
        this.schedulePreview(index);
        this.actionActors?.forEach((actor,i) => { actor.visible=i===index; });
    }

    hidePreview() {
        this.previewSerial=(this.previewSerial || 0)+1;
        this.previewEntry=null;
        if(this.previewTimer && this.sources.delete(this.previewTimer)) GLib.source_remove(this.previewTimer);
        this.previewTimer=null;
        this.previewBox?.hide();
        this.previewBox?.destroy_all_children();
    }

    schedulePreview(index) {
        const entry=this.rows[index];
        if(!entry || !this.settings.get_boolean('hover-preview') || this.previewEntry===entry.id) return;
        this.hidePreview();
        this.previewEntry=entry.id;
        const serial=this.previewSerial;
        this.previewTimer=this.later(this.settings.get_int('hover-preview-delay'),() => {
            this.previewTimer=null;
            this.client.request('preview',{entry:entry.id}).then(result => {
                if(this.dead || serial!==this.previewSerial || !this.history.isOpen) return;
                const row=this.rowActors[index];
                if(!row?.get_stage()) return;
                const scale=new Gio.Settings({schema_id:'org.gnome.desktop.interface'}).get_double('text-scaling-factor');
                const [rx,ry]=row.get_transformed_position();
                const monitor=Main.layoutManager.monitors.find(m=>rx>=m.x && rx<m.x+m.width && ry>=m.y && ry<m.y+m.height) || Main.layoutManager.primaryMonitor;
                if(!monitor) return;
                const area=Main.layoutManager.getWorkAreaForMonitor(monitor.index);
                const width=Math.min(400*scale,area.width-48);
                this.previewBox.set_style(`width: ${width}px;`);
                if(result.image) {
                    const imageScale=Math.min(1,(width-24)/result.width,(area.height/2)/result.height);
                    this.previewBox.add_child(new St.Icon({gicon:Gio.icon_new_for_string(result.image),
                        width:result.width*imageScale,height:result.height*imageScale,icon_size:Math.max(result.width,result.height)*imageScale}));
                } else {
                    const lines=result.text.split('\n');
                    let text=lines.slice(0,12).join('\n');
                    if(result.truncated || lines.length>12) text+='\n…';
                    const label=new St.Label({text});
                    label.clutter_text.set_line_wrap(true);
                    label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
                    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
                    label.set_style(`max-height: ${Math.min(280*scale,area.height/2)}px;`);
                    this.previewBox.add_child(label);
                }
                this.previewBox.show();
                const [mw,mh]=this.previewBox.get_preferred_width(-1);
                const w=Math.max(mw,mh);
                const h=this.previewBox.get_preferred_height(w)[1];
                const [hx]=this.history.actor.get_transformed_position();
                let x=hx+this.history.actor.width+8;
                if(x+w>area.x+area.width-12) x=hx-w-8;
                x=Math.max(area.x+12,Math.min(x,area.x+area.width-w-12));
                const y=Math.max(area.y+12,Math.min(ry,area.y+area.height-h-12));
                this.previewBox.set_position(x,y);
            }).catch(error => {
                if(!this.dead && serial===this.previewSerial) { this.hidePreview(); console.error(`Clipboard preview: ${error.message}`); }
            });
        });
    }

    key(event) {
        const key = event.get_key_symbol();
        const control = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const entry = this.rows[this.selected];
        if (key === Clutter.KEY_Escape) { this.history.close(); return Clutter.EVENT_STOP; }
        if (key === Clutter.KEY_Down || key === Clutter.KEY_Up) {
            const atSearch = global.stage.key_focus === this.search.clutter_text;
            const absolute=atSearch ? 0 : Math.max(0,Math.min(this.total-1,this.renderOffset+this.selected+(key===Clutter.KEY_Down?1:-1)));
            if(absolute<this.renderOffset || absolute>=this.renderOffset+this.rows.length) {
                this.pendingFocus=absolute;
                this.offset=Math.max(0,Math.min(Math.max(0,this.total-PAGE),absolute-OVERSCAN));
                this.refresh(false);
            } else {
                this.selected=absolute-this.renderOffset;
                this.rowActors[this.selected]?.grab_key_focus();
            }
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
        if(!this.settings.get_boolean('enable-deletion')) return;
        if (entry.favorite && this.settings.get_boolean('confirm-pinned-delete')) {
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
                can_focus:true, style_class:'entry ci-edit-textbox'});
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

    async select(entry, paste = true, forcePaste = false) {
        const payload = await this.client.request('get',{entry:entry.id});
        if (this.dead) return;
        this.history.close();
        this.currentId=entry.id;
        if(this.settings.get_boolean('move-item-first')) await this.client.request('touch',{entry:entry.id});
        this.updatePanel(entry.id);
        this.skipCapture = true;
        this.clipboard.set_content(TYPE,payload.mimetype,new GLib.Bytes(GLib.base64_decode(payload.data)));
        this.later(80, () => {
            if (forcePaste || (paste && this.settings.get_boolean('paste-on-select'))) {
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
                // St.Clipboard owns the native buffer for the duration of this callback.
                // Convert while it is valid; only JS-owned data crosses the await.
                const data = await new Promise(resolve => this.clipboard.get_content(TYPE,mimetype,(_,bytes) => {
                    if (!bytes || !bytes.get_size()) { resolve(null); return; }
                    let payload=bytes.get_data();
                    if(mimetype.startsWith('text/') || mimetype==='STRING' || mimetype==='UTF8_STRING') {
                        if(this.settings.get_boolean('strip-text')) payload=new TextEncoder().encode(new TextDecoder().decode(payload).trim());
                    }
                    resolve(GLib.base64_encode(payload));
                }));
                if (this.dead || generation !== this.captureGeneration || this.settings.get_boolean('private-mode')) return;
                if (!data) continue;
                if (mimetype==='UTF8_STRING' || mimetype==='STRING') mimetype='text/plain;charset=utf-8';
                const saved=await this.client.request('add',{mimetype,data,maximum:this.settings.get_int('max-history-items')});
                this.currentId=saved.id;
                this.updatePanel(saved.id);
                if(this.settings.get_boolean('notify-on-copy')) Main.notify('Clipboard archive','Saved clipboard item');
                if(this.settings.get_boolean('blink-icon-on-copy')) { this.panelIcon.opacity=80; this.later(140,()=>{this.panelIcon.opacity=255;}); }
                if (this.history.isOpen) this.refresh();
                break;
            }
        } catch (error) { if (!this.dead) console.error(`Clipboard capture: ${error.message}`); }
    }

    searchOptions() {
        return {case_sensitive:this.settings.get_boolean('case-sensitive-search'),regex:getSearchMode(this.settings)===2,pinned_bottom:this.settings.get_boolean('pinned-on-bottom')};
    }

    applySettings() {
        const mode=this.settings.get_int('display-mode');
        this.button.visible=mode!==3;
        this.panelIcon.visible=mode===0 || mode===2;
        this.panelLabel.visible=mode===1 || mode===2;
        this.panelArrow.visible=!this.settings.get_boolean('disable-down-arrow');
        this.privateSwitch.visible=this.settings.get_boolean('show-private-mode');
        if(this.clearAction) this.clearAction.visible=this.settings.get_boolean('show-clear-history-button') && this.settings.get_boolean('enable-deletion');
        if(this.preferencesAction) this.preferencesAction.visible=this.settings.get_boolean('show-settings-button');
        this.search.hint_text=getSearchMode(this.settings)===2 ? 'Search with a regular expression…' : 'Search clipboard history…';
        this.searchRow.visible=this.settings.get_boolean('show-search-bar');
        if(!this.searchRow.visible) this.search.text='';
        if(this.currentId) this.updatePanel(this.currentId);
    }

    updatePanel(id) {
        if(this.settings.get_boolean('private-mode')) { this.panelLabel.text='Private mode'; return; }
        if(this.settings.get_int('display-mode')===0) return;
        this.run(async () => {
            const item=await this.client.request('summary',{entry:id});
            if(this.dead || !item || id!==this.currentId || this.settings.get_boolean('private-mode')) return;
            this.panelLabel.text=item.mimetype.startsWith('image/') ? 'Image' : [...item.text.replace(/\s+/g,' ')].slice(0,this.settings.get_int('topbar-preview-size')).join('');
        });
    }

    async clearArchive() {
        const keep=this.settings.get_boolean('keep-selected-on-clear');
        await this.client.request('clear',{keep:keep ? this.currentId : null});
        if(this.dead) return;
        if(!keep) {
            this.skipCapture=true;
            this.clipboard.set_text(TYPE,'');
            this.panelLabel.text='Clipboard';
            this.later(100,()=>{this.skipCapture=false;});
        }
        if(this.settings.get_boolean('notify-on-clear')) Main.notify('Clipboard archive','Unpinned history cleared');
    }

    clear() {
        if(!this.settings.get_boolean('enable-deletion')) return;
        this.history.close();
        const clear=()=>this.run(()=>this.clearArchive());
        if(this.settings.get_boolean('confirm-clear')) this.dialogs.open('Clear unpinned history?', this.settings.get_boolean('keep-selected-on-clear') ? 'Pinned entries and the selected entry will be kept. The current clipboard will be preserved.' : 'Pinned entries will be kept. The current clipboard will also be emptied.', '', 'Clear','Cancel',clear);
        else clear();
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
                    this.run(() => this.clearArchive());
                }
            } else this.lastClear=null;
            return GLib.SOURCE_CONTINUE;
        });
    }

    cycle(direction) {
        this.run(async () => {
            const entry=await this.client.request('cycle',{entry:this.currentId,direction,pinned_bottom:this.settings.get_boolean('pinned-on-bottom')});
            if (entry) { await this.select(entry,false); if(this.settings.get_boolean('notify-on-cycle')) Main.notify('Clipboard archive','Selected another history item'); }
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
        this.hidePreview();
        this.previewBox?.destroy();
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
