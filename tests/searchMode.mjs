import assert from 'node:assert/strict';
import {getSearchMode} from '../searchMode.js';
// Existing settings may have both old toggles enabled. Preserve effective behavior.
for (const regex of [false,true]) for (const semantic of [false,true]) {
    const settings={get_user_value:()=>null,get_boolean:key=>key==='regex-search'?regex:semantic};
    assert.equal(getSearchMode(settings),regex?2:semantic?1:0);
    for (const mode of [0,1,2])
        assert.equal(getSearchMode({...settings,get_user_value:()=>mode,get_int:()=>mode}),mode);
}
console.log('Search mode migration and explicit selection passed');
