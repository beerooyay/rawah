import assert from 'node:assert/strict';
import { dialogueTurn, dialogueMessages, dialogueContext } from '../../src/crew-dialogue.js';
const user = content => ({role:'user',content});
const state=JSON.stringify({player:'Blaize',weather:'Clear',nearbyNamedPlaces:[{name:'Bench Lake',metres:700}],controls:'B: cast a line',recentEvents:'Trey said open the map'});
for(const text of ['what up','oh you gon throw me in da lake','FUCK U','you talk too damn much bitch']) {
 const turn=dialogueTurn([user(text)]);
 assert.equal(turn.mode,'chat');
 assert.doesNotMatch(dialogueContext(state,turn),/Bench Lake|cast a line|open the map/);
}
assert.equal(dialogueTurn([user('FUCK U')]).shouted,true);
assert.equal(dialogueTurn([user('Honestly this week has been rough. Can we just sit here?')]).mode,'care');
const history=[user('you talk too damn much bitch'),{role:'assistant',content:'Open your map and pick a lake.'},user('oh yeah lil bitch')];
assert.equal(dialogueTurn(history).short,true);
assert.match(dialogueMessages('Trey',history,state)[0].content,/drop it now/);
assert.equal(dialogueTurn([...history,user('elaborate')]).short,false);
for(const text of ['what should we do today?','any spots you wanna see?','how do i cast a line?','WHERE IS THE MAP?']) {
 const turn=dialogueTurn([user(text)]);assert.equal(turn.mode,'help',text);
 assert.match(dialogueContext(state,turn),/Bench Lake/);
 assert.doesNotMatch(dialogueContext(state,turn),/Trey said/);
}
assert.equal(dialogueTurn([user('stop telling me to open the map')]).mode,'repair');
console.log('dialogue: banter/help separation, history deduplication, persistent brevity, shouting and sincere turns passed');
