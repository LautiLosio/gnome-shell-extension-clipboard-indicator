import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ArchivePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings=this.getSettings();
        const page=new Adw.PreferencesPage({title:'Clipboard archive',icon_name:'edit-paste-symbolic'});
        window.add(page);
        const behavior=new Adw.PreferencesGroup({title:'Capture and history',
            description:'History is retained until you delete it. The old entry and cache limits no longer apply.'});
        page.add(behavior);
        const toggle=(group,title,subtitle,key) => {
            const row=new Adw.SwitchRow({title,subtitle});
            settings.bind(key,row,'active',Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        };
        toggle(behavior,'Private mode','Pause new clipboard capture.','private-mode');
        toggle(behavior,'Capture images','Store original images locally.','cache-images');
        toggle(behavior,'Paste on selection','Otherwise selection copies the entry to the clipboard.','paste-on-select');
        toggle(behavior,'Clear on login','Delete unpinned archive entries when the extension starts.','clear-on-boot');
        toggle(behavior,'Scheduled clearing','Delete unpinned entries at the interval below.','clear-history-on-interval');
        const minutes=Adw.SpinRow.new_with_range(1,10080,1);
        minutes.title='Clear interval in minutes';
        settings.bind('clear-history-interval',minutes,'value',Gio.SettingsBindFlags.DEFAULT);
        behavior.add(minutes);
        const excluded=new Adw.EntryRow({title:'Excluded app IDs, comma separated',text:settings.get_strv('excluded-apps').join(', ')});
        excluded.connect('changed',() => settings.set_strv('excluded-apps',excluded.text.split(',').map(x=>x.trim()).filter(Boolean)));
        behavior.add(excluded);
        const popup=new Adw.PreferencesGroup({title:'History popup'});
        page.add(popup);
        toggle(popup,'Prefer the text caret','Fall back to the mouse pointer when the app does not report a caret.','prefer-caret');
        toggle(popup,'Local semantic search','Combine meaning-based results with keyword search. Requires the local model runtime.','semantic-search');
        toggle(popup,'Enable shortcuts','','enable-keybindings');
        for (const [key,title] of [['toggle-menu','Open history'],['private-mode-binding','Toggle private mode'],['clear-history','Clear unpinned history']]) {
            const row=new Adw.EntryRow({title,text:settings.get_strv(key)[0] || ''});
            row.show_apply_button=true;
            row.connect('apply',() => {
                if (!row.text.trim()) { settings.set_strv(key,[]); return; }
                const [valid,keyval,mods]=Gtk.accelerator_parse(row.text);
                if (valid && Gtk.accelerator_valid(keyval,mods)) {
                    settings.set_strv(key,[Gtk.accelerator_name(keyval,mods)]);
                    row.remove_css_class('error');
                } else row.add_css_class('error');
            });
            popup.add(row);
        }
        popup.add(new Adw.ActionRow({title:'Shortcut format',subtitle:'Example: &lt;Control&gt;&lt;Super&gt;v. Press the apply button to save.'}));
        window.set_default_size(620,650);
    }
}
