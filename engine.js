// Moteur de règles de Ruines, partagé entre le navigateur et le serveur.
(function (root) {
  var N = 7;
  var LAYOUT = ['VRVBVRV','RBVBVBR','BRBVBRB','RBVRVBR','BRBVBRB','RBVBVBR','VRVBVRV'];
  var CODE = { B: 0, R: 1, V: 2 };

  function fresh() {
    var colors = LAYOUT.join('').split('').map(function (c) { return CODE[c]; });
    var pieces = [];
    for (var i = 0; i < N * N; i++) pieces.push(null);
    for (var c = 0; c < N; c++) {
      pieces[c] = { p: 1, chef: c === 3 };
      pieces[(N - 1) * N + c] = { p: 0, chef: c === 3 };
    }
    return { colors: colors, pieces: pieces, turn: 0, winner: null, reason: '', last: null };
  }

  // Cases d'arrivée possibles pour la pièce en i.
  function legal(st, i) {
    var pc = st.pieces[i];
    if (!pc) return [];
    var r = Math.floor(i / N), c = i % N, col = st.colors[i];
    var out = [];
    function inb(rr, cc) { return rr >= 0 && rr < N && cc >= 0 && cc < N; }
    if (col === 2) {
      for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        var tr = r + 2 * dr, tc = c + 2 * dc;
        if (!inb(tr, tc)) continue;
        var t = st.pieces[tr * N + tc];
        if (!t || t.p !== pc.p) out.push(tr * N + tc);
      }
      return out;
    }
    var dirs = col === 0 ? [[1,0],[-1,0],[0,1],[0,-1]] : [[1,1],[1,-1],[-1,1],[-1,-1]];
    var max = pc.chef ? 2 : N;
    dirs.forEach(function (d) {
      for (var k = 1; k <= max; k++) {
        var rr = r + d[0] * k, cc = c + d[1] * k;
        if (!inb(rr, cc)) break;
        var t = st.pieces[rr * N + cc];
        if (!t) { out.push(rr * N + cc); continue; }
        if (t.p !== pc.p) out.push(rr * N + cc);
        break;
      }
    });
    return out;
  }

  function allMoves(st, player) {
    var out = [];
    for (var i = 0; i < N * N; i++) {
      var pc = st.pieces[i];
      if (!pc || pc.p !== player) continue;
      var ts = legal(st, i);
      for (var k = 0; k < ts.length; k++) out.push([i, ts[k]]);
    }
    return out;
  }

  // Renvoie l'état après le coup (ne modifie pas st).
  function apply(st, from, to) {
    var n = { colors: st.colors.slice(), pieces: st.pieces.slice(), turn: st.turn, winner: null, reason: '', last: null };
    var pc = n.pieces[from];
    var cap = n.pieces[to];
    var before = n.colors[from];
    n.pieces[to] = pc;
    n.pieces[from] = null;
    n.colors[from] = (before + 1) % 3;
    n.last = { from: from, to: to, p: pc.p, before: before, after: n.colors[from], cap: !!cap };
    var goalRow = pc.p === 0 ? 0 : N - 1;
    if (cap && cap.chef) { n.winner = pc.p; n.reason = 'chefcap'; }
    else if (pc.chef && Math.floor(to / N) === goalRow) { n.winner = pc.p; n.reason = 'chefgoal'; }
    else {
      n.turn = 1 - n.turn;
      if (!allMoves(n, n.turn).length) { n.winner = pc.p; n.reason = 'stuck'; }
    }
    return n;
  }

  var api = { N: N, fresh: fresh, legal: legal, allMoves: allMoves, apply: apply };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RuinesEngine = api;
})(this);
