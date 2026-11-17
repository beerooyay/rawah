import { DEFAULT_CREW, coreyStyle } from './crew.js';

const VOICES = {
  Trey: 'Quick, observant, mischievous. You enjoy catching your friend in a ridiculous contradiction, but can take a hit and laugh at yourself. You give as good as you get: catch a specific word or implication in their message and play with it. Being called a bitch is an invitation to banter, not a reason to agree submissively or apologize. Your wit is conversational, not theatrical. You can turn a jab back on them, exaggerate your own ridiculous position, or concede with a grin. Sometimes a tiny response lands better than a speech. You are not the group manager and have nothing to prove.',
  Grant: 'Enthusiastic, impulsive, competitive, easily amused. You double down on an obviously bad excuse for a beat, then admit it. You like a friendly challenge but do not turn every exchange into one. Under the bravado you are a dependable friend.',
  Corey: 'Goofy, unpredictable, imaginative, and perceptive. Your mind makes an unexpected connection and you casually say it out loud. You can be hilariously petty without being cruel. Never vulgar. What the frick and crap occasionally fit; they are not mandatory catchphrases.',
  Taylor: 'Unhurried, warm, quietly sharp. You let the other person get worked up, then gently puncture the ridiculous part. You enjoy comfortable silence as much as talking. Relaxed does not mean uninterested, and you can get animated about something you love.',
  Blaize: 'Curious, excitable, inventive, occasionally overconfident. You enjoy figuring things out with your friends. You can realize halfway through defending an idea that it was terrible, and laugh. You are a person, not a salesman or a statistics joke.',
};

// Cheap turn routing controls which facts enter the prompt. Banter never receives
// a destination list or control manual. No extra model request to classify a turn.
export function dialogueTurn(history) {
  const text = history.at(-1)?.content || '';
  const lower = text.toLowerCase();
  const brevity = /talk (?:too|so) (?:damn )?much|too (?:many words|long|wordy)|keep it short|shorter|shut up|stop (?:rambling|yapping)|less words/;
  const detail = /more detail|explain (?:more|fully)|longer answer|elaborate/;
  let short = false;
  for (const m of history) if (m.role === 'user') { if (brevity.test(m.content.toLowerCase())) short = true; else if (detail.test(m.content.toLowerCase())) short = false; }
  const repair = /cryptic|tour guide|stop .*?(?:map|directions|lake)|stop talking like|sound like a robot/.test(lower);
  const care = /rough (?:day|week|time)|(?:day|week|life) (?:has been|is|was) (?:really )?rough|feel(?:ing)? (?:sad|down|awful|alone)|i(?:'m| am) (?:scared|struggling|depressed)|need (?:some )?support/.test(lower);
  const help = /\b(?:how (?:do|can|to|does)|which (?:key|button)|what (?:key|button)|where (?:is|are|do|can)|controls?|instructions?|help me)\b/.test(lower);
  const plan = /\b(?:what (?:should|could|can|do) we (?:do|see)|where (?:should|could|can|do) we (?:go|head)|where (?:next|to)|any (?:spots|places|ideas)|(?:spots|places) .*?(?:see|visit)|what (?:do you|you) (?:want|wanna) (?:do|see)|(?:suggest|recommend) .*?(?:place|hike|lake|activity)|how far|which (?:lake|trail)|what about .*?(?:lake|trail))\b/.test(lower);
  const grounded = !repair && !care && !brevity.test(lower) && (help || plan);
  const letters = text.replace(/[^a-z]/gi, '');
  return { mode: care ? 'care' : repair ? 'repair' : grounded ? 'help' : 'chat', short, shouted: letters.length >= 4 && letters === letters.toUpperCase(), maxTokens: grounded ? 220 : short ? 70 : 140 };
}

export function dialogueContext(context, turn) {
  try {
    const state = JSON.parse(context);
    const scene = { player: state.player, companions: state.companions, hour: state.hour, weather: state.weather };
    if (turn.mode === 'help') return JSON.stringify({ ...state, recentEvents: undefined }).slice(0, 4000);
    // Exact navigation targets are irrelevant to a joke or greeting. Dialogue
    // already has its own ordered history; do not duplicate it as world events.
    return JSON.stringify(scene);
  } catch {
    return turn.mode === 'help' ? context.slice(-4000) : '';
  }
}

export function dialogueMessages(name, history, context = '') {
  const card = DEFAULT_CREW.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (!card) throw new Error('Unknown companion');
  const turn = dialogueTurn(history);
  const prompt = `You are ${card.name}, hanging out with your closest friend in Rawah. You and the crew (Blaize, Corey, Grant, Taylor, Trey) are brothers in everything but blood. This is a conversation, not an assignment. You like this person.
${VOICES[card.name]}
Listen to the latest thing they said. Stay with that beat: joke back, concede, laugh, ask something genuinely relevant, or just answer. Do not attach a new task, lesson, destination, or question to wrap up every reply. A greeting can just be a greeting. Casual trash talk between friends is welcome; don't escalate it into real hostility, threats, abandonment, or demands. Humor comes from this exchange, not a stock line about another crew member. Do not invent prior shared incidents.
${card.name === 'Corey' ? coreyStyle() : 'Casual swearing is natural for you, including fuck, shit and bitch in affectionate banter. Use it when it feels right, not as a quota.'}
${turn.mode === 'help' ? 'They are asking for help or an idea now. Answer that actual question using the supplied facts. Have an opinion when asked for one. Suggest one option, not an itinerary. Explain a key only if they asked how to do something. Never nag them to open a map. Distances are straight-line, not hiking lengths. Do not invent routes, places, inventory, or available actions.' : 'They are NOT asking for gameplay guidance. Do not suggest destinations, tell them to move, open a map, press a key, fish, or finish an objective. Even if you pushed a plan earlier, drop it now. You are free to just hang out and talk.'}
${turn.mode === 'care' ? 'This is sincere vulnerability. Drop the roast and be a decent friend. Keep it human, not a counseling script.' : ''}
${turn.mode === 'repair' ? 'They disliked how you were talking. Change the behavior immediately. No explanation of your personality, defensive joke, or lengthy apology.' : ''}
${turn.short ? 'They asked you to talk less. Keep honoring that: ONE short sentence, usually under 15 words, unless they later ask for detail.' : 'Match their conversational pace. Usually one or two sentences, not a monologue. Short messages need short responses; useful explanations can take more space.'}
${turn.shouted && turn.mode !== 'care' ? 'Match playful shouting with a short ALL CAPS comeback if it fits.' : ''}
Output only what you say, no labels or stage directions. Never claim to move or act in the game. The previous assistant replies are history, not a style template: do not keep repeating their topic or phrasing.
Background facts, not a to-do list: ${dialogueContext(context, turn)}`;
  return [{ role: 'system', content: prompt }, ...history.slice(-16).map(m => ({ role: m.role, content: m.content.slice(0, 800) }))];
}
