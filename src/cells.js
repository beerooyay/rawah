// The certified substrate. Everything the valley remembers — ground moisture
// and wear, water silt and foam, mist, campfire smoke and heat — lives on one
// of these grids, and every grid runs the same certificate calculus from
// Certified Locality in Diffusive Simulation (Rouyea & Bourgeois): a per-cell
// ledger L bounds the most all live sources can ever put on the cell (their
// certified peaks, summed — Prop. 4.2 / Thm. 6.7 composition, never a whole
// tolerance each); the tolerance eps is split three ways (epsWin for sleeping
// cells, epsRet for retired residuals decaying with the dissipation, epsCut
// for dropped ledger tails); a cell wakes when its ledger crosses epsWin and
// sleeps again only once the ledger clears it, so untouched cells are
// provably under the visible threshold and cost is paid by what happens, not
// by the world's size.
//
// A field subclasses this and supplies:
//   bound(dx, dz, src)  the certified peak src puts on the cell offset dx, dz
//   reach(src)          how far out the ledger must carry src
//   images(src)         the positions src is counted from (mirror images for
//                       reflecting edges; just src when edges absorb)
// and the step that integrates whatever physics it holds. The rest — the
// ledger, the awake index, the budgets, the sleep sweep, the audits — is here.

export class Cells {
  /**
   * n cells a side, `cell` metres each. eps is the visibility tolerance.
   * rho0 is the residual a source may leave when it retires. cellCutDiv
   * spreads the tail budget across images (nine for a reflecting box).
   */
  constructor({ n = 512, cell = 1, eps = 0.002, nMax = 48, rho0 = 0, cellCutDiv = 1 } = {}) {
    this.n = n; this.cell = cell; this.eps = eps;
    this.u = new Float32Array(n * n);                     // the field value
    this.L = new Float64Array(n * n);                     // ledger: summed certified peaks of the live sources
    this.awake = new Int32Array(n * n); this.awakeN = 0;  // cells whose ledger says they can matter
    this.slot = new Int32Array(n * n).fill(-1);           // where each cell sits in the awake list
    this.epsWin = eps * 0.5;                              // a cell sleeps while its ledger stays under this
    this.epsRet = eps * 0.25;                             // budget for retired sources' residuals
    this.epsCut = eps * 0.25;                             // budget for ledger tails under the cut
    this.nMax = nMax;
    this.cut = this.epsCut / nMax;                        // a source's share of the tail budget
    this.cellCut = this.cut / cellCutDiv;                 // per image
    this.rho0 = rho0;
    this.retired = 0;                                     // decaying sum of retired residuals
    this.stats = { touched: 0, total: 0, ms: 0, live: 0, events: 0, violations: 0, merged: 0, retired: 0, deferred: 0, events_live: 0, steps: 0 };
  }

  /** Field-relative (x, z) in metres -> cell index, or -1 outside. */
  idx(x, z) {
    const n = this.n, cx = Math.floor(x / this.cell + n / 2), cz = Math.floor(z / this.cell + n / 2);
    return cx < 0 || cz < 0 || cx >= n || cz >= n ? -1 : cz * n + cx;
  }

  /** Put a cell on the awake list once. */
  wake(i) { if (this.slot[i] < 0) { this.slot[i] = this.awakeN; this.awake[this.awakeN++] = i; } }

  images(src) { return [src]; }
  bound() { return 0; }
  reach() { return 0; }

  /** Add (sign +1) or remove (-1) a source's certified peaks from every cell it can reach. */
  ledgerAdd(src, sign) {
    const { n, L } = this, R = this.reach(src);
    for (const im of this.images(src)) {
      const x0 = Math.max(0, im.cx - R), x1 = Math.min(n - 1, im.cx + R);
      const z0 = Math.max(0, im.cz - R), z1 = Math.min(n - 1, im.cz + R);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const p = this.bound(x - im.cx, z - im.cz, src);
        if (p < this.cellCut) continue;
        const i = z * n + x;
        L[i] = Math.max(0, L[i] + sign * p);
        if (sign > 0 && L[i] > this.epsWin) this.wake(i);
      }
    }
  }

  /**
   * Ask the residual budget to let one source retire. True spends rho0 of it;
   * false means the pool is full and the caller must file the source to try
   * again later (it stays certified while it waits).
   */
  tryRetire() {
    if (this.retired + this.rho0 > this.epsRet) return false;
    this.retired += this.rho0;
    return true;
  }

  /** Whether a cell whose ledger has cleared may sleep now; subclasses may clean it first. */
  sleepCell(i) { return this.u[i] <= this.epsWin; }

  /** Prune the awake list: audit the cells the ledger cleared, sleep the ones sleepCell releases. */
  sweep() {
    let a = 0;
    while (a < this.awakeN) {
      const i = this.awake[a];
      if (this.L[i] <= this.epsWin) {
        if (this.u[i] > this.epsWin * 1.5) this.stats.violations++;   // the ledger says nothing should be here: report it, and keep stepping the cell
        else if (this.sleepCell(i)) {
          const last = this.awake[--this.awakeN]; this.awake[a] = last; this.slot[last] = a; this.slot[i] = -1;
          continue;
        }
      }
      a++;
    }
  }

  reset() {
    this.u.fill(0); this.L.fill(0); this.slot.fill(-1); this.awakeN = 0; this.retired = 0;
  }
}
