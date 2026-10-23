// The field guide: wildlife, plants, checkpoints and a few things to find. Every
// entry is a thing you can notice in the world. Each check (twice a second)
// asks whether the place you stand in and the time of day would show it, and
// a sighting is rolled with `chance`, so a bull elk turns up at dusk in the
// meadow, not on demand. Lakes and summits live in the journal (state.discovered)
// and are shown alongside these by map.js. The found list is saved with the game.

const ENTRIES = [
  // wildlife: habitat, time of day, and how often one shows up when the habitat is right
  { id: 'elk', group: 'Wildlife', name: 'Elk', chance: 0.08, when: (f) => f.cover.meadow > 0.6 && (f.dusk || f.dawn),
    note: 'Bull elk with a rack like a coat stand, crossing the meadow at first light.' },
  { id: 'deer', group: 'Wildlife', name: 'Mule deer', chance: 0.05, when: (f) => f.cover.forest > 0.25 && f.cover.forest < 0.7 && !f.night,
    note: 'Big ears, white rump. Out at the forest edge where the grass meets the trees.' },
  { id: 'chickadee', group: 'Wildlife', name: 'Mountain chickadee', chance: 0.1, when: (f) => f.cover.forest > 0.4 && !f.night && !f.rain,
    note: 'The fee-bee-bee call comes first. Look up and it is already gone.' },
  { id: 'nutcracker', group: 'Wildlife', name: 'Clark\'s nutcracker', chance: 0.08, when: (f) => f.cover.krumm > 0.3 && !f.night,
    note: 'Grey, black and white, hoarding pine seeds near the treeline.' },
  { id: 'pika', group: 'Wildlife', name: 'American pika', chance: 0.12, when: (f) => f.cover.rock > 0.4 && f.alpine && !f.night,
    note: 'A round little haymaker that whistles from the talus and stores grass for winter.' },
  { id: 'marmot', group: 'Wildlife', name: 'Yellow-bellied marmot', chance: 0.1, when: (f) => f.cover.rock > 0.5 && f.alpine && !f.night && !f.rain,
    note: 'Sunning on the big rocks above the trees, and sounding the alarm when you come close.' },
  // flora: what grows where
  { id: 'lodgepole', group: 'Flora', name: 'Lodgepole pine', chance: 0.3, when: (f) => f.cover.forest > 0.5 && !f.alpine,
    note: 'Tall and thin, with needles in pairs. Fire opens its cones, so they grow thick after a burn.' },
  { id: 'spruce', group: 'Flora', name: 'Engelmann spruce', chance: 0.3, when: (f) => f.cover.forest > 0.5 && f.elev > f.treeline - 700,
    note: 'Soft needles that roll between your fingers. The cold-loving spruce of the high forest.' },
  { id: 'fir', group: 'Flora', name: 'Subalpine fir', chance: 0.25, when: (f) => f.cover.krumm > 0.3,
    note: 'Spire-shaped and dark, the last tree to hold on before the tundra.' },
  { id: 'krummholz', group: 'Flora', name: 'Krummholz', chance: 0.3, when: (f) => f.cover.krumm > 0.5,
    note: 'Trees shaped by wind: flagged, crooked and low, growing only on the side the wind does not reach.' },
  { id: 'aspen', group: 'Flora', name: 'Quaking aspen', chance: 0.3, when: (f) => f.cover.aspen > 0.35,
    note: 'White bark and leaves that tremble in still air. Every stand is one root system.' },
  { id: 'fireweed', group: 'Flora', name: 'Fireweed', chance: 0.25, when: (f) => f.cover.snag > 0.3,
    note: 'The first thing to bloom after a burn. The pink spikes climb as the season goes on.' },
  { id: 'columbine', group: 'Flora', name: 'Colorado blue columbine', chance: 0.2, when: (f) => f.cover.meadow > 0.5 && f.alpine,
    note: 'The state flower. Blue and white spurs, growing in wet alpine meadows.' },
  // checkpoints: one per trailhead, found by standing at it (main.js supplies these)
  // easter eggs: found by doing something, not by standing somewhere
  { id: 'starlight', group: 'Easter eggs', name: 'Starlight', chance: 1, when: (f) => f.slept >= 1 && f.night,
    note: 'Slept in the tent with the whole Milky Way over the fly.', hint: 'Sleep in your tent at night.' },
  { id: 'timber', group: 'Easter eggs', name: 'Timber!', chance: 1, when: (f) => f.felled >= 1,
    note: 'Brought down your first tree. Stand clear, and call it out.', hint: 'Fell a tree with an axe or machete.' },
  { id: 'carrier', group: 'Easter eggs', name: 'Heavy lifting', chance: 1, when: (f) => f.carried,
    note: 'Picked up a stone and carried it on the trail.', hint: 'Pick up a loose stone with E.' },
  { id: 'mover', group: 'Easter eggs', name: 'Quake', chance: 1, when: (f) => f.lifted >= 1,
    note: 'Lifted the ground with nothing but attention.', hint: 'Lift the ground with telekinesis.' },
  { id: 'racer', group: 'Easter eggs', name: 'Last one there', chance: 1, when: (f) => f.raced >= 1,
    note: 'Beat your friend to a summit or a lake.', hint: 'Win a race with the together menu.' },
  { id: 'fire', group: 'Easter eggs', name: 'Hearth', chance: 1, when: (f) => f.fire,
    note: 'Got a fire going below the trees.', hint: 'Build a campfire at your tent.' },
  { id: 'twelve', group: 'Easter eggs', name: 'Twelve kilometres', chance: 1, when: (f) => f.km >= 12,
    note: 'Walked twelve kilometres of the Rawah in a day.', hint: 'Hike twelve kilometres.' },
];

export class Guide {
  constructor(checkpoints = []) {
    this.entries = [...ENTRIES, ...checkpoints];
    this.found = new Set();
    this.byId = new Map(this.entries.map((e) => [e.id, e]));
  }

  /** Roll each entry the facts allow. Returns the entries found just now. */
  check(f) {
    const fresh = [];
    for (const e of this.entries) {
      if (this.found.has(e.id) || !e.when(f)) continue;
      if (Math.random() < e.chance) { this.found.add(e.id); fresh.push(e); }
    }
    return fresh;
  }

  /** Found by something outside the habitat rolls (a checkpoint reached, a lake). */
  mark(id) {
    if (!this.byId.has(id) || this.found.has(id)) return null;
    this.found.add(id);
    return this.byId.get(id);
  }

  save() { return [...this.found]; }
  load(list) { this.found = new Set(list || []); }
}
