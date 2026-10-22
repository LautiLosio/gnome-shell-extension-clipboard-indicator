import assert from 'node:assert/strict';
import {placePopup} from '../placement.js';
for(const area of [{x:0,y:32,width:1920,height:1048},{x:-1280,y:0,width:1280,height:720}]) {
    for(const x of [area.x,area.x+area.width/2,area.x+area.width-1]) {
        for(const y of [area.y,area.y+area.height/2,area.y+area.height-1]) {
            const p=placePopup(x,y,area);
            assert(p.x>=area.x+12 && p.x<=area.x+area.width-12);
            assert(p.y>=area.y+12 && p.y<=area.y+area.height-12);
            assert(p.width<=area.width-24);
            if(y===area.y) assert(!p.above);
            if(y===area.y+area.height-1) assert(p.above);
        }
    }
}
console.log('Placement tests passed');
