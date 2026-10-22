import Adw from 'gi://Adw';
import {getSearchMode, SEARCH_MODES} from './searchMode.js';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Tab organization follows Tudmotu's Clipboard Indicator preferences.
// Controls below are connected to the fork's archive/popup behavior.
export default class ArchivePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings=this.getSettings();
        window._settings=settings;
        window.set_default_size(760,720);
        const pages={};
        for(const [name,icon] of [['UI','view-grid-symbolic'],['Behavior','system-run-symbolic'],['Search','system-search-symbolic'],['Limits','preferences-system-symbolic'],['Exclusion','action-unavailable-symbolic'],['Topbar','edit-paste-symbolic'],['Notifications','preferences-system-notifications-symbolic'],['Shortcuts','input-keyboard-symbolic']]) {
            pages[name]=new Adw.PreferencesPage({title:name,icon_name:icon});window.add(pages[name]);
        }
        const group=(page,title,description='') => {
            const g=new Adw.PreferencesGroup({title,description});pages[page].add(g);return g;
        };
        const toggle=(g,title,key,subtitle='') => {
            const row=new Adw.SwitchRow({title,subtitle});
            settings.bind(key,row,'active',Gio.SettingsBindFlags.DEFAULT);g.add(row);return row;
        };
        const spin=(g,title,key,min,max,step=1,subtitle='') => {
            const row=Adw.SpinRow.new_with_range(min,max,step);row.title=title;row.subtitle=subtitle;
            settings.bind(key,row,'value',Gio.SettingsBindFlags.DEFAULT);g.add(row);return row;
        };
        const note=(g,title,subtitle) => g.add(new Adw.ActionRow({title,subtitle}));
        const layout=group('UI','History popup','Continuous lazy scrolling. Only a bounded set of result rows is kept in GNOME Shell.');
        toggle(layout,'Show search bar','show-search-bar');
        toggle(layout,'Prefer the input caret','prefer-caret','Use the mouse pointer when the app does not report a caret.');
        spin(layout,'Popup width','popup-width',300,1000,10,'Logical pixels, adjusted for system text scaling.');
        spin(layout,'Popup height','popup-height',240,900,10,'Clamped to the monitor work area.');
        spin(layout,'Screen edge margin','popup-margin',4,80);
        spin(layout,'Text preview characters','preview-size',10,100);
        toggle(layout,'Pinned items at the bottom','pinned-on-bottom');
        const previews=group('UI','Hover previews');
        const previewToggle=toggle(previews,'Preview the active entry','hover-preview','Hover a row or focus it with the keyboard to preview text or an image.');
        const previewDelay=spin(previews,'Preview delay in milliseconds','hover-preview-delay',100,2000,50);
        previewToggle.bind_property('active',previewDelay,'sensitive',2);
        const actions=group('UI','Row actions','Icons appear only on the hovered or keyboard-selected entry. Pin, edit, tag and delete shortcuts remain available when their icons are hidden.');
        for(const [title,key] of [['Pin / unpin','show-pin-button'],['Edit text','show-edit-button'],['Open image in viewer','show-preview-button'],['Edit tag','show-tag-button'],['Delete','show-delete-button'],['Paste immediately','paste-button']]) toggle(actions,title,key);
        const tray=group('UI','Quick settings menu');
        toggle(tray,'Show private mode','show-private-mode');toggle(tray,'Show preferences','show-settings-button');toggle(tray,'Show clear history','show-clear-history-button');
        const capture=group('Behavior','Capture');
        toggle(capture,'Private mode','private-mode','Pause new captures. Existing history stays available.');
        toggle(capture,'Capture images','cache-images');
        toggle(capture,'Trim surrounding whitespace','strip-text');
        toggle(capture,'Paste on selection','paste-on-select','Otherwise selecting an entry only copies it. The row Paste icon always pastes.');
        toggle(capture,'Move selected items to the top','move-item-first');
        const deletion=group('Behavior','Deletion and cleanup');
        toggle(deletion,'Allow manual deletion','enable-deletion','Controls the Delete action and manual clearing. Scheduled cleanup and retention limits still apply.');
        toggle(deletion,'Confirm clearing history','confirm-clear');
        toggle(deletion,'Confirm deleting pinned entries','confirm-pinned-delete');
        toggle(deletion,'Keep the selected entry when clearing','keep-selected-on-clear');
        toggle(deletion,'Clear unpinned entries when the extension starts','clear-on-boot');
        const periodic=toggle(deletion,'Clear unpinned history periodically','clear-history-on-interval');
        const interval=spin(deletion,'Clear interval in minutes','clear-history-interval',1,10080);
        periodic.bind_property('active',interval,'sensitive',2);
        const search=group('Search','Search');
        const searchMode=new Adw.ComboRow({title:'Search mode',model:Gtk.StringList.new(SEARCH_MODES),selected:getSearchMode(settings)});
        search.add(searchMode);
        searchMode.connect('notify::selected',()=>settings.set_int('search-mode',searchMode.selected));
        const caseRow=toggle(search,'Case-sensitive matching','case-sensitive-search');
        const updateSearch=()=>{
            searchMode.selected=getSearchMode(settings);
            searchMode.subtitle=[
                'Indexed word-prefix matching. Case-sensitive matching uses an exact substring instead.',
                'Combines keyword matching and local semantic similarity. Falls back to keywords if the model is unavailable.',
                'Pattern matching in a separate process with a one-second deadline. Broad patterns may time out.',
            ][searchMode.selected];
            caseRow.subtitle=searchMode.selected===1
                ? 'Affects only the keyword results, using exact substrings. Semantic matches remain independent of letter case.'
                : searchMode.selected===2 ? 'Match uppercase and lowercase letters exactly in patterns.' : 'Use exact substrings with matching letter case instead of indexed word prefixes.';
        };
        const searchSignals=['search-mode','regex-search','semantic-search'].map(key=>settings.connect('changed::'+key,updateSearch));
        window.connect('close-request',()=>{searchSignals.forEach(id=>settings.disconnect(id));return false;});
        updateSearch();
        note(search,'Screenshot text','OCR runs locally in the background when the optional local-search runtime is installed.');
        const retention=group('Limits','Archive retention','No count limit is applied unless you explicitly set one here.');
        spin(retention,'Maximum unpinned entries','max-history-items',0,10000000,100,'0 means unlimited. Applied when new entries are captured; pinned entries are protected.');
        const legacy=group('Limits','Changes from the upstream cache');
        note(legacy,'The old JSON cache-size limit is retired','The SQLite archive has no disk quota yet. Its attachments, thumbnails and indexes use disk space. No setting here claims to cap total disk use.');
        note(legacy,'“Cache only pinned items” is not implemented','All captured entries persist until deletion. Use Private mode or Excluded apps to prevent capture. The old setting remains saved for rollback.');
        const exclusion=group('Exclusion','Excluded applications','Enter the application ID or WM class used by the focused window.');
        const excludedList=new Gtk.ListBox({selection_mode:Gtk.SelectionMode.NONE,css_classes:['boxed-list']});
        exclusion.add(excludedList);
        const refreshExcluded=() => {
            for(let child=excludedList.get_first_child();child;) { const next=child.get_next_sibling();excludedList.remove(child);child=next; }
            for(const app of settings.get_strv('excluded-apps')) {
                const row=new Adw.ActionRow({title:app,use_markup:false});
                const remove=new Gtk.Button({icon_name:'edit-delete-symbolic',valign:Gtk.Align.CENTER,tooltip_text:'Remove exclusion',css_classes:['flat']});
                remove.connect('clicked',()=>{settings.set_strv('excluded-apps',settings.get_strv('excluded-apps').filter(x=>x!==app));refreshExcluded();});
                row.add_suffix(remove);excludedList.append(row);
            }
        };
        refreshExcluded();
        const add=new Adw.EntryRow({title:'Add application ID',show_apply_button:true});
        add.connect('apply',()=>{const app=add.text.trim();if(app){settings.set_strv('excluded-apps',[...new Set([...settings.get_strv('excluded-apps'),app])]);add.text='';refreshExcluded();}});
        exclusion.add(add);
        const panel=group('Topbar','Panel indicator','The panel button opens quick settings. History remains a separate shortcut-opened popup.');
        const mode=new Adw.ComboRow({title:'Display',model:Gtk.StringList.new(['Icon','Clipboard text','Icon and clipboard text','Hidden'])});
        settings.bind('display-mode',mode,'selected',Gio.SettingsBindFlags.DEFAULT);panel.add(mode);
        spin(panel,'Text preview characters','topbar-preview-size',1,100);
        toggle(panel,'Hide the down arrow','disable-down-arrow');
        toggle(panel,'Blink the icon on copy','blink-icon-on-copy');
        const notices=group('Notifications','Notifications');
        toggle(notices,'Notify on capture','notify-on-copy','Notifications do not include copied text.');
        toggle(notices,'Notify when cycling entries','notify-on-cycle');
        toggle(notices,'Notify when history is cleared','notify-on-clear');
        const shortcuts=group('Shortcuts','Global shortcuts','Click a shortcut to record a key combination. Escape cancels; Backspace clears it.');
        toggle(shortcuts,'Enable shortcuts','enable-keybindings');
        for(const [key,title] of [['toggle-menu','Open history'],['private-mode-binding','Toggle private mode'],['clear-history','Clear history'],['prev-entry','Previous history entry'],['next-entry','Next history entry']]) {
            const row=new Adw.ActionRow({title});
            const button=new Gtk.Button({valign:Gtk.Align.CENTER});
            const update=()=>{const raw=settings.get_strv(key)[0];if(!raw){button.label='Disabled';return;}const [valid,val,mods]=Gtk.accelerator_parse(raw);button.label=valid?Gtk.accelerator_get_label(val,mods):raw;};
            update();
            button.connect('clicked',()=>{
                const dialog=new Adw.Window({title:'Set shortcut',transient_for:window,modal:true,default_width:400,default_height:160});
                const box=new Gtk.Box({orientation:Gtk.Orientation.VERTICAL,spacing:12,margin_top:24,margin_bottom:24,margin_start:24,margin_end:24});
                box.append(new Gtk.Label({label:'Press a shortcut for '+title,wrap:true}));
                box.append(new Gtk.Label({label:'Escape cancels. Backspace disables it.',css_classes:['dim-label'],wrap:true}));
                dialog.set_content(box);
                const controller=new Gtk.EventControllerKey();
                controller.connect('key-pressed',(_,keyval,_code,state)=>{
                    if(keyval===0xff1b){dialog.close();return true;}
                    if(keyval===0xff08){settings.set_strv(key,[]);update();dialog.close();return true;}
                    const mods=state & Gtk.accelerator_get_default_mod_mask();
                    if(Gtk.accelerator_valid(keyval,mods)){settings.set_strv(key,[Gtk.accelerator_name(keyval,mods)]);update();dialog.close();}
                    return true;
                });
                dialog.add_controller(controller);dialog.present();
            });
            row.add_suffix(button);shortcuts.add(row);
        }
    }
}
