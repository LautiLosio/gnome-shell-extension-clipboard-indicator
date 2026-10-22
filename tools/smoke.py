#!/usr/bin/env python3
"""Prepare isolated GNOME test data; launch with tools/smoke.sh."""
import importlib.util
from pathlib import Path
import shutil

repo=Path(__file__).resolve().parents[1]
root=repo.parent/'work/gnome-smoke'
uuid='clipboard-indicator@lautilosio.github.io'
ext=root/'data/gnome-shell/extensions'/uuid
ext.mkdir(parents=True,exist_ok=True)
for file in repo.glob('*.js'): shutil.copy(file,ext/file.name)
for name in ['history_service.py','metadata.json','stylesheet.css']:
 shutil.copy(repo/name,ext/name)
shutil.copytree(repo/'schemas',ext/'schemas',dirs_exist_ok=True)
spec=importlib.util.spec_from_file_location('history',repo/'history_service.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
a=m.Archive(root/'data'/uuid)
with a.db:
 for i in range(1000): a.add('text/plain',f'Synthetic entry {i} audio networking test'.encode(),i%29==0)
a.db.close()
p=ext/'extension.js'
s=p.read_text().replace('const pointer = global.get_pointer();','const pointer = this.testPointer || global.get_pointer();')
s=s.replace('this.configureInterval();','''this.configureInterval();
        const points=[[2,35],[1278,35],[2,798],[1278,798]];
        let step=0;
        const check=() => {
            this.history.close();
            this.testPointer=points[step];
            this.openHistory();
            this.later(500, () => {
                const [x,y]=this.history.actor.get_transformed_position();
                const [w,h]=this.history.actor.get_transformed_size();
                console.log('ARCHIVE_SMOKE: corner=' + step + ',rows=' + this.rows.length + ',popup=' + [x,y,w,h]);
                this.setActive(4);
                console.log('ARCHIVE_SMOKE: visibleActions=' + this.actionActors.filter(a=>a.visible).length);
                const action=this.actionActors[4].get_first_child();
                console.log('ARCHIVE_SMOKE: actionSize=' + action.width + 'x' + action.height);
                if(++step<points.length) check();
                else {
                    console.log('ARCHIVE_SMOKE: rowHeight=' + this.rowHeight);
                    this.adjustment.value=500*this.rowHeight;
                    this.later(700,() => {
                        console.log('ARCHIVE_SMOKE: scrollDown offset=' + this.renderOffset + ',rows=' + this.rows.length + ',value=' + this.adjustment.value + ',height=' + this.rowActors[0].height);
                        if(this.renderOffset<400 || this.rows.length>60) throw new Error('Lazy scrolling failed');
                        this.adjustment.value=0;
                        this.later(700,() => {
                            console.log('ARCHIVE_SMOKE: scrollBack offset=' + this.renderOffset);
                            if(this.renderOffset!==0) throw new Error('Reverse scrolling failed');
                            this.setActive(4);
                            this.later(600,()=>{
                                console.log('ARCHIVE_SMOKE: hoverPreview=' + this.previewBox.visible);
                                if(!this.previewBox.visible) throw new Error('Hover preview did not open');
                                this.hidePreview();
                            });
                            this.later(800,()=>{this.history.close();});
                            this.later(850,()=>{this.button.menu.open();});
                            this.later(900,()=>console.log('ARCHIVE_SMOKE: settings=' + this.button.menu.isOpen));
                            this.later(1100, () => {
                                this.button.menu.close();
                                this.openPreferences();
                                this.later(1000, () => { this.disable(); console.log('ARCHIVE_SMOKE: disabled'); });
                            });
                        });
                    });
                }
            });
        };
        this.later(2000,check);''')
p.write_text(s)
print(root)
