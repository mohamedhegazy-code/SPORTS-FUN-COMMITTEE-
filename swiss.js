"use strict";
// Swiss-system engine for the chess tournament format. Pure functions only -
// no database, no Express - so it can be exercised directly by the test
// scripts. server.js owns storage and the HTTP routes and calls into here.
//
// Round data shape (stored on the tournament as t.swiss.rounds):
//   { number: 1, pairings: [ { id, board, a, b, result } ] }
//     a = player with the White pieces, b = Black (null for a bye)
//     result: null (not played yet) | "1-0" | "0-1" | "1/2-1/2"   (played)
//                                   | "1-0f" | "0-1f" | "0-0f"   (forfeits - not played)
//                                   | "bye"                      (b is null, scores 1 point)
//
// Ranking follows the FIDE Swiss tie-break convention the club regulation
// asks for: Points, then Direct Encounter (only when every tied player has
// met every other one), Buchholz Cut-1, Buchholz, Sonneborn-Berger, number of
// wins, and finally the tournament's seed order as a last deterministic
// fallback (rows still level after every tie-break are flagged `tiedOnAll`
// so the arbiter knows a draw of lots / play-off is needed - prizes are not
// shared between tied players under this regulation).

const PLAYED_RESULTS = new Set(["1-0", "0-1", "1/2-1/2"]);
const FORFEIT_RESULTS = new Set(["1-0f", "0-1f", "0-0f"]);
const ALL_RESULTS = new Set([...PLAYED_RESULTS, ...FORFEIT_RESULTS]);

// [white points, black points] for a (non-bye) result string.
function gamePoints(result) {
  switch (result) {
    case "1-0":
    case "1-0f":
      return [1, 0];
    case "0-1":
    case "0-1f":
      return [0, 1];
    case "1/2-1/2":
      return [0.5, 0.5];
    case "0-0f":
      return [0, 0];
    default:
      return null;
  }
}

// ----------------------------------------------------------------- ledger --
// Turns the stored rounds into one entry per (player, round) for every round
// that has a recorded result (or where the player was left out of the round
// entirely - they get an "absent" entry worth 0). Pairings with no result yet
// contribute nothing.
function buildLedger(rounds, ids) {
  const ledger = new Map();
  const get = (id) => {
    if (!ledger.has(id)) ledger.set(id, []);
    return ledger.get(id);
  };
  ids.forEach((id) => get(id));
  rounds.forEach((round) => {
    const inRound = new Set();
    for (const p of round.pairings) {
      inRound.add(p.a);
      if (p.b != null) inRound.add(p.b);
      if (p.result == null) continue;
      if (p.b == null) {
        get(p.a).push({ round: round.number, opp: null, pts: 1, played: false, kind: "bye", color: null });
        continue;
      }
      const pts = gamePoints(p.result);
      if (!pts) continue;
      const played = PLAYED_RESULTS.has(p.result);
      const kind = played ? "game" : "forfeit";
      get(p.a).push({ round: round.number, opp: p.b, pts: pts[0], played, kind, color: "W" });
      get(p.b).push({ round: round.number, opp: p.a, pts: pts[1], played, kind, color: "B" });
    }
    for (const id of ids) {
      if (!inRound.has(id)) get(id).push({ round: round.number, opp: null, pts: 0, played: false, kind: "absent", color: null });
    }
  });
  return ledger;
}

function sumPoints(entries) {
  return entries.reduce((s, e) => s + e.pts, 0);
}

// ------------------------------------------------------------- standings --
// ids: every entrant id to rank. seedOrder: array of entrant ids (final
// fallback). totalRounds: planned number of rounds (used for the FIDE
// "virtual opponent" on unplayed games).
function computeStandings(rounds, ids, seedOrder, totalRounds) {
  const ledger = buildLedger(rounds, ids);
  const R = Math.max(totalRounds || 0, rounds.length);
  const points = new Map();
  for (const id of ids) points.set(id, sumPoints(ledger.get(id) || []));

  const rows = ids.map((id) => {
    const entries = (ledger.get(id) || []).slice().sort((x, y) => x.round - y.round);
    const contribs = [];
    let before = 0;
    let wins = 0;
    let games = 0;
    let sb = 0;
    for (const e of entries) {
      let c;
      if (e.played && e.opp != null) {
        c = points.has(e.opp) ? points.get(e.opp) : 0;
        games++;
        if (e.pts === 1) wins++;
      } else {
        // FIDE virtual opponent for a bye / forfeit / absence: the player's
        // own score going into that round, plus the opposite of the
        // player's result that round, then draws for every later round.
        c = before + (1 - e.pts) + 0.5 * Math.max(0, R - e.round);
      }
      contribs.push(c);
      sb += e.pts * c;
      before += e.pts;
    }
    const total = contribs.reduce((s, x) => s + x, 0);
    const cut1 = contribs.length > 1 ? total - Math.min(...contribs) : total;
    const recorded = entries.filter((e) => e.kind !== "absent").length;
    return {
      entrantId: id,
      points: points.get(id),
      games,
      recorded,
      wins,
      buchholz: total,
      buchholzCut1: cut1,
      sonnebornBerger: sb,
      direct: 0,
      seed: seedOrder.indexOf(id) === -1 ? 1e9 : seedOrder.indexOf(id),
      _entries: entries,
    };
  });

  // Direct encounter: within each group of equal points, only if every pair
  // in the group has played each other.
  const byPoints = new Map();
  rows.forEach((r) => {
    if (!byPoints.has(r.points)) byPoints.set(r.points, []);
    byPoints.get(r.points).push(r);
  });
  for (const group of byPoints.values()) {
    if (group.length < 2) continue;
    const idSet = new Set(group.map((g) => g.entrantId));
    let allMet = true;
    for (const g of group) {
      for (const h of group) {
        if (g === h) continue;
        if (!g._entries.some((e) => e.played && e.opp === h.entrantId)) allMet = false;
      }
    }
    if (!allMet) continue;
    for (const g of group) {
      g.direct = g._entries.filter((e) => e.played && idSet.has(e.opp)).reduce((s, e) => s + e.pts, 0);
    }
  }

  const keyOrder = ["points", "direct", "buchholzCut1", "buchholz", "sonnebornBerger", "wins"];
  rows.sort((x, y) => {
    for (const k of keyOrder) if (y[k] !== x[k]) return y[k] - x[k];
    return x.seed - y.seed;
  });
  rows.forEach((r, i) => {
    r.rank = i + 1;
    r.tiedOnAll = false;
  });
  for (let i = 1; i < rows.length; i++) {
    if (keyOrder.every((k) => rows[i][k] === rows[i - 1][k]) && rows[i].recorded > 0) {
      rows[i].tiedOnAll = true;
      rows[i - 1].tiedOnAll = true;
    }
  }
  rows.forEach((r) => delete r._entries);
  return rows;
}

// --------------------------------------------------------------- pairing --
// Dutch-style pairing: players are ordered by score (then seed). Each score
// group is split in two halves and the top half is paired against the
// bottom half. A depth-first search with that preference order makes sure
// nobody meets an opponent twice and that an odd player is floated down a
// group instead of leaving the round un-pairable. If no rematch-free
// pairing exists (a field smaller than rounds+1, say) the search is retried
// allowing the smallest possible number of rematches, which are reported.
function historyOf(rounds) {
  const met = new Map(); // id -> Set(opponent ids)
  const colors = new Map(); // id -> ["W","B",...]
  const byes = new Map(); // id -> count
  const touch = (id) => {
    if (!met.has(id)) met.set(id, new Set());
    if (!colors.has(id)) colors.set(id, []);
    if (!byes.has(id)) byes.set(id, 0);
  };
  for (const round of rounds) {
    for (const p of round.pairings) {
      touch(p.a);
      if (p.b == null) {
        byes.set(p.a, byes.get(p.a) + 1);
        continue;
      }
      touch(p.b);
      met.get(p.a).add(p.b);
      met.get(p.b).add(p.a);
      colors.get(p.a).push("W");
      colors.get(p.b).push("B");
    }
  }
  return { met, colors, byes };
}

function chooseColors(x, y, hist, flip) {
  const cx = hist.colors.get(x.id) || [];
  const cy = hist.colors.get(y.id) || [];
  const bal = (c) => c.filter((k) => k === "W").length - c.filter((k) => k === "B").length;
  const bx = bal(cx);
  const by = bal(cy);
  if (bx < by) return [x.id, y.id];
  if (bx > by) return [y.id, x.id];
  const lx = cx[cx.length - 1];
  const ly = cy[cy.length - 1];
  if (lx !== ly) {
    if (lx === "B") return [x.id, y.id];
    if (ly === "B") return [y.id, x.id];
  }
  return flip ? [y.id, x.id] : [x.id, y.id];
}

// players: [{ id, points, seed }]. Returns { pairs: [[idA, idB]...], bye,
// warnings } or { error }.
function pairPlayers(players, rounds, startingPairingId) {
  const hist = historyOf(rounds);
  const sorted = players.slice().sort((a, b) => b.points - a.points || a.seed - b.seed);
  const n = sorted.length;
  if (n < 2) return { error: "Need at least 2 active players to pair a round" };

  const metBefore = (a, b) => (hist.met.get(a) || new Set()).has(b);

  function search(P, maxRematches) {
    const used = new Array(P.length).fill(false);
    const pairs = [];
    let nodes = 0;
    const NODE_CAP = 400000;
    let aborted = false;
    function dfs(rematches) {
      if (aborted) return false;
      let i = 0;
      while (i < P.length && used[i]) i++;
      if (i >= P.length) return true;
      if (++nodes > NODE_CAP) {
        aborted = true;
        return false;
      }
      const R = [];
      for (let j = i; j < P.length; j++) if (!used[j]) R.push(j);
      if (R.length < 2) return false;
      let g = 0;
      while (g < R.length && P[R[g]].points === P[i].points) g++;
      const mEven = g - (g % 2);
      const tp = g >= 2 ? mEven / 2 : 1;
      const order = [];
      if (g >= 2) {
        const same = [];
        for (let k = 1; k < g; k++) same.push(k);
        same.sort((k1, k2) => Math.abs(k1 - tp) - Math.abs(k2 - tp) || k2 - k1);
        order.push(...same);
      }
      for (let k = Math.max(g, 1); k < R.length; k++) order.push(k);
      used[i] = true;
      for (const k of order) {
        const j = R[k];
        const isRematch = metBefore(P[i].id, P[j].id);
        const nextRematches = rematches + (isRematch ? 1 : 0);
        if (nextRematches > maxRematches) continue;
        used[j] = true;
        pairs.push([i, j]);
        if (dfs(nextRematches)) return true;
        pairs.pop();
        used[j] = false;
        if (aborted) break;
      }
      used[i] = false;
      return false;
    }
    const ok = dfs(0);
    return ok ? pairs.map(([i, j]) => [P[i], P[j]]) : null;
  }

  function solve(P) {
    const maxExtra = Math.floor(P.length / 2);
    for (let allowed = 0; allowed <= maxExtra; allowed++) {
      const found = search(P, allowed);
      if (found) return found;
    }
    // Last-resort greedy so a round can always be produced.
    const out = [];
    for (let i = 0; i + 1 < P.length; i += 2) out.push([P[i], P[i + 1]]);
    return out;
  }

  let pairsFound = null;
  let byePlayer = null;
  if (n % 2 === 1) {
    // Bye: lowest-ranked player who hasn't had one yet (anyone, if all have).
    const fromBottom = sorted.slice().reverse();
    const noBye = fromBottom.filter((p) => (hist.byes.get(p.id) || 0) === 0);
    const hadBye = fromBottom.filter((p) => (hist.byes.get(p.id) || 0) > 0);
    const candidates = [...noBye, ...hadBye];
    // Prefer a bye candidate for whom a rematch-free pairing of everyone
    // else exists, but never fail the round over it.
    for (const cand of candidates) {
      const rest = sorted.filter((p) => p !== cand);
      const found = search(rest, 0);
      if (found) {
        byePlayer = cand;
        pairsFound = found;
        break;
      }
    }
    if (!pairsFound) {
      byePlayer = candidates[0];
      pairsFound = solve(sorted.filter((p) => p !== byePlayer));
    }
  } else {
    pairsFound = solve(sorted);
  }

  const warnings = [];
  const rank = new Map(sorted.map((p, i) => [p.id, i]));
  const decorated = pairsFound.map(([x, y]) => {
    if (metBefore(x.id, y.id)) warnings.push({ type: "rematch", a: x.id, b: y.id });
    return { x, y, top: Math.max(x.points, y.points), sum: x.points + y.points, best: Math.min(rank.get(x.id), rank.get(y.id)) };
  });
  decorated.sort((p, q) => q.top - p.top || q.sum - p.sum || p.best - q.best);
  const pairs = decorated.map((d, i) => {
    const hi = rank.get(d.x.id) < rank.get(d.y.id) ? d.x : d.y;
    const lo = hi === d.x ? d.y : d.x;
    return chooseColors(hi, lo, hist, i % 2 === 1);
  });
  return { pairs, bye: byePlayer ? byePlayer.id : null, warnings };
}

// Builds the pairing records for the next round.
// activeIds: ids that will play. standingsRows: output of computeStandings
// (for current points). Returns { round, warnings } or { error }.
function buildNextRound({ activeIds, rounds, seedOrder, totalRounds, nextPairingId }) {
  const standings = computeStandings(rounds, activeIds, seedOrder, totalRounds);
  const players = standings.map((s) => ({ id: s.entrantId, points: s.points, seed: s.seed }));
  const res = pairPlayers(players, rounds, nextPairingId);
  if (res.error) return res;
  let pid = nextPairingId;
  const pairings = res.pairs.map(([a, b], i) => ({ id: pid++, board: i + 1, a, b, result: null }));
  if (res.bye != null) pairings.push({ id: pid++, board: null, a: res.bye, b: null, result: "bye" });
  return {
    round: { number: rounds.length + 1, pairings },
    warnings: res.warnings,
    nextPairingId: pid,
  };
}

module.exports = {
  ALL_RESULTS,
  PLAYED_RESULTS,
  FORFEIT_RESULTS,
  gamePoints,
  buildLedger,
  computeStandings,
  buildNextRound,
  pairPlayers,
  historyOf,
};
