(function () {
  var E = window.RuinesEngine, N = E.N;
  var COLOR_NAME = ['bleue', 'rouge', 'verte'];
  var COLOR_M = ['bleu', 'rouge', 'vert'];
  var DESC = ['elle va en ligne droite', 'elle va en diagonale', 'elle saute de 2 cases'];
  var GLYPH = [
    '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3v18M3 12h18"/></svg>',
    '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>',
    '<svg class="glyph" viewBox="0 0 24 24" fill="currentColor"><circle cx="4" cy="4" r="2.4"/><circle cx="20" cy="4" r="2.4"/><circle cx="4" cy="20" r="2.4"/><circle cx="20" cy="20" r="2.4"/></svg>'
  ];
  var STORE = 'ruines-partie';

  var S = E.fresh(), undoStack = [], sel = null, justMoved = false, mode = 'duo', thinking = false;
  var online = null;      // { code, seat, token, oppJoined, oppConnected, rematch }
  var ws = null, lobbyErr = '', wantOnline = false;

  // ---------- Qui est qui ----------
  function me(p) {
    if (mode === 'bot') return p === 0;
    if (mode === 'online' && online) return p === online.seat;
    return null;
  }
  function nameOf(p) {
    var m = me(p);
    if (m === null) return p === 0 ? 'Os' : 'Ébène';
    if (m) return 'Toi';
    return mode === 'bot' ? 'Le tavernier' : 'Ton adversaire';
  }

  // ---------- Bot ----------
  var WIN = 100000, deadline, aborted;
  function evaluate(st, player) {
    var score = 0;
    for (var i = 0; i < N * N; i++) {
      var pc = st.pieces[i];
      if (!pc) continue;
      var s = 100;
      if (pc.chef) {
        var r = Math.floor(i / N);
        var progress = pc.p === 0 ? (N - 1 - r) : r;
        s += progress * progress * 6;
      }
      score += pc.p === player ? s : -s;
    }
    score += 2 * (E.allMoves(st, player).length - E.allMoves(st, 1 - player).length);
    return score;
  }
  function negamax(st, depth, alpha, beta, ply) {
    if (depth === 0) return evaluate(st, st.turn);
    if (Date.now() > deadline) { aborted = true; return 0; }
    var moves = E.allMoves(st, st.turn);
    moves.sort(function (a, b) { return (st.pieces[b[1]] ? 1 : 0) - (st.pieces[a[1]] ? 1 : 0); });
    var best = -Infinity;
    for (var k = 0; k < moves.length; k++) {
      var nx = E.apply(st, moves[k][0], moves[k][1]);
      var v = nx.winner !== null ? (nx.winner === st.turn ? WIN - ply - 1 : -(WIN - ply - 1))
        : -negamax(nx, depth - 1, -beta, -alpha, ply + 1);
      if (aborted) return 0;
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    return best;
  }
  function botMove(st) {
    var moves = E.allMoves(st, st.turn);
    if (!moves.length) return null;
    deadline = Date.now() + 900;
    var bestMove = moves[Math.floor(Math.random() * moves.length)];
    for (var depth = 1; depth <= 6; depth++) {
      aborted = false;
      var scored = [], alpha = -Infinity;
      for (var k = 0; k < moves.length; k++) {
        var nx = E.apply(st, moves[k][0], moves[k][1]);
        var v = nx.winner !== null ? (nx.winner === st.turn ? WIN : -WIN)
          : -negamax(nx, depth - 1, -Infinity, -alpha + 1, 1);
        if (aborted) break;
        scored.push([v + Math.random() * 3, moves[k]]);
        if (v > alpha) alpha = v;
      }
      if (aborted) break;
      scored.sort(function (a, b) { return b[0] - a[0]; });
      bestMove = scored[0][1];
      moves = scored.map(function (s) { return s[1]; });
      if (scored[0][0] >= WIN - 10) break;
    }
    return bestMove;
  }
  function maybeBot() {
    if (mode !== 'bot' || S.winner !== null || S.turn !== 1) return;
    thinking = true;
    render();
    setTimeout(function () {
      var m = botMove(S);
      thinking = false;
      if (m && mode === 'bot') playLocal(m[0], m[1]); else render();
    }, 350);
  }

  // ---------- Coups ----------
  function playLocal(from, to) {
    undoStack.push(JSON.stringify(S));
    S = E.apply(S, from, to);
    sel = null;
    justMoved = true;
    render();
    maybeBot();
  }

  function canPlay() {
    if (S.winner !== null || thinking) return false;
    if (mode === 'bot') return S.turn === 0;
    if (mode === 'online') return !!online && online.oppJoined && S.turn === online.seat;
    return true;
  }

  function onCell(i) {
    if (!canPlay()) return;
    if (sel !== null && E.legal(S, sel).indexOf(i) !== -1) {
      if (mode === 'online') { wsSend({ t: 'move', from: sel, to: i }); sel = null; render(); }
      else playLocal(sel, i);
      return;
    }
    var pc = S.pieces[i];
    sel = (pc && pc.p === S.turn && sel !== i) ? i : null;
    justMoved = false;
    render();
  }

  // ---------- Réseau ----------
  function saved() { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { return null; } }
  function save(v) { try { if (v) localStorage.setItem(STORE, JSON.stringify(v)); else localStorage.removeItem(STORE); } catch (e) {} }
  function setUrl(code) {
    try { window.history.replaceState(null, '', code ? '?partie=' + code : location.pathname); } catch (e) {}
  }

  var pending = [];
  function wsSend(obj) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return; }
    pending.push(obj);
    connect();
  }
  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onopen = function () {
      var q = pending; pending = [];
      q.forEach(function (o) { ws.send(JSON.stringify(o)); });
    };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'room') onRoom(m);
      else if (m.t === 'error') onError(m.msg);
    };
    ws.onclose = function () {
      ws = null;
      // Reconnexion automatique tant qu'on est dans une partie en ligne.
      if (mode === 'online' && online) {
        setTimeout(function () {
          if (mode === 'online' && online) wsSend({ t: 'join', code: online.code, token: online.token });
        }, 1500);
      }
    };
  }

  function onRoom(m) {
    if (mode !== 'online') return;
    var prev = JSON.stringify(S.last);
    var swapped = online && online.seat !== m.seat;
    online = { code: m.code, seat: m.seat, token: m.token, oppJoined: m.oppJoined, oppConnected: m.oppConnected, rematch: m.rematch };
    save({ code: m.code, token: m.token });
    setUrl(m.code);
    justMoved = !swapped && !!m.S.last && JSON.stringify(m.S.last) !== prev;
    S = m.S;
    if (S.turn !== online.seat) sel = null;
    lobbyErr = '';
    render();
  }

  function onError(msg) {
    lobbyErr = msg;
    online = null;
    save(null);
    setUrl(null);
    render();
  }

  function leaveOnline() {
    if (online) wsSend({ t: 'leave' });
    online = null;
    save(null);
    setUrl(null);
  }

  function joinCode(code) {
    code = String(code || '').trim().toUpperCase();
    if (code.length !== 4) { lobbyErr = 'Le code fait 4 lettres.'; render(); return; }
    var sv = saved();
    wsSend({ t: 'join', code: code, token: sv && sv.code === code ? sv.token : null });
  }

  // ---------- Affichage ----------
  var boardEl = document.getElementById('board');
  var frameEl = document.getElementById('frame');
  var turnbarEl = document.getElementById('turnbar');
  var turnEl = document.getElementById('turn');
  var statusEl = document.getElementById('status');
  var undoBtn = document.getElementById('undo');
  var resetBtn = document.getElementById('reset');
  var lobbyEl = document.getElementById('lobby');
  var roomEl = document.getElementById('room');
  var modeBtns = document.querySelectorAll('[data-mode]');

  function reasonText(st) {
    if (st.reason === 'chefcap') return 'le Chef adverse est capturé.';
    if (st.reason === 'chefgoal') return 'le Chef a atteint la dernière rangée.';
    return nameOf(1 - st.winner) + ' ne peut plus bouger.';
  }

  function render() {
    modeBtns.forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false'); });

    var inLobby = mode === 'online' && !online;
    lobbyEl.hidden = !inLobby;
    roomEl.hidden = !(mode === 'online' && online);
    frameEl.hidden = inLobby;
    turnbarEl.hidden = inLobby;
    statusEl.hidden = inLobby;
    document.getElementById('lobbyerr').textContent = lobbyErr;

    undoBtn.hidden = mode === 'online';
    resetBtn.textContent = mode === 'online' ? 'Quitter' : 'Nouvelle partie';
    undoBtn.disabled = undoStack.length === 0 || thinking;

    if (mode === 'online' && online) {
      var link = location.origin + location.pathname + '?partie=' + online.code;
      document.getElementById('roomcode').textContent = online.code;
      document.getElementById('roomlink').textContent = link;
      document.getElementById('roomstate').textContent = !online.oppJoined
        ? 'En attente de ton adversaire. Envoie-lui le lien ou le code.'
        : online.oppConnected
          ? 'Ton adversaire est là. Tu joues ' + (online.seat === 0 ? 'l\'os' : 'l\'ébène') + '.'
          : 'Ton adversaire s\'est déconnecté. Il peut revenir avec le même lien.';
    }
    if (inLobby) return;

    // Le joueur ébène en ligne voit le plateau retourné, ses pièces en bas.
    var flip = mode === 'online' && online && online.seat === 1;
    var targets = sel !== null ? E.legal(S, sel) : [];
    var html = '';
    for (var d = 0; d < N * N; d++) {
      var i = flip ? N * N - 1 - d : d;
      var cls = 'cell c' + S.colors[i];
      var pc = S.pieces[i];
      if (targets.indexOf(i) !== -1) cls += pc ? ' capture' : ' target';
      if (i === sel) cls += ' sel';
      if (S.last && (i === S.last.from || i === S.last.to)) cls += ' last';
      if (justMoved && S.last && i === S.last.from) cls += ' flip';
      var label = 'Case ' + COLOR_NAME[S.colors[i]] + (pc ? ', pièce ' + nameOf(pc.p) + (pc.chef ? ' (Chef)' : '') : '');
      html += '<button type="button" class="' + cls + '" data-i="' + i + '" aria-label="' + label + '">' +
        GLYPH[S.colors[i]] +
        (pc ? (pc.chef
          ? '<span class="stack"><span class="piece p' + pc.p + ' low"></span><span class="piece p' + pc.p + ' high"></span></span>'
          : '<span class="piece p' + pc.p + '"></span>') : '') +
        '<span class="mark"></span></button>';
    }
    boardEl.innerHTML = html;

    if (S.winner !== null) {
      var w = me(S.winner);
      var who = w === null ? nameOf(S.winner) + ' gagne' : w ? 'Tu gagnes' : nameOf(S.winner) + ' gagne';
      turnEl.innerHTML = '<span class="dot p' + S.winner + '"></span>' + who;
      var extra = '', btnLabel = 'Rejouer';
      if (mode === 'online' && online) {
        var mine = online.rematch.indexOf(online.seat) !== -1;
        var theirs = online.rematch.indexOf(1 - online.seat) !== -1;
        if (mine) extra = '<br><small>En attente de ton adversaire pour la revanche…</small>';
        else if (theirs) extra = '<br><small>Ton adversaire veut une revanche.</small>';
        btnLabel = 'Revanche';
      }
      statusEl.innerHTML = '<div class="parch win"><p>' + who + ' : ' + reasonText(S) + extra + '</p>' +
        '<button class="btn" type="button" id="again">' + btnLabel + '</button></div>';
      document.getElementById('again').onclick = function () {
        if (mode === 'online') { wsSend({ t: 'rematch' }); }
        else reset();
      };
    } else {
      var turnLabel;
      if (mode === 'bot') turnLabel = S.turn === 0 ? 'À toi de jouer' : 'Le tavernier réfléchit…';
      else if (mode === 'online') turnLabel = !online.oppJoined ? 'En attente…' : S.turn === online.seat ? 'À toi de jouer' : 'Ton adversaire joue…';
      else turnLabel = 'Au tour de ' + (S.turn === 0 ? 'l\'Os' : 'l\'Ébène');
      turnEl.innerHTML = '<span class="dot p' + S.turn + '"></span>' + turnLabel;

      var msg;
      if (sel !== null) {
        var pc2 = S.pieces[sel];
        msg = 'Cette pièce part d\'une case <strong>' + COLOR_NAME[S.colors[sel]] + '</strong> : ' + DESC[S.colors[sel]] +
          (pc2.chef ? ', 2 cases maximum.' : '.') + (targets.length ? '' : ' Aucun coup possible depuis ici.');
      } else if (S.last) {
        var actor = me(S.last.p) === true ? 'Tu as' : nameOf(S.last.p) + ' a';
        msg = actor + (S.last.cap ? ' capturé une pièce. ' : ' joué. ') +
          'La case quittée est passée du <strong>' + COLOR_M[S.last.before] + '</strong> au <strong>' + COLOR_M[S.last.after] + '</strong>.';
      } else if (mode === 'online') {
        msg = 'Tu joues ' + (online.seat === 0 ? 'l\'os, tu commences.' : 'l\'ébène, ton adversaire commence.');
      } else if (mode === 'bot') {
        msg = 'Tu joues les pièces en os, en bas. Touche une pièce pour voir où elle peut aller.';
      } else {
        msg = 'Touche une de tes pièces pour voir où elle peut aller.';
      }
      statusEl.innerHTML = '<div class="parch"><p class="info">' + msg + '</p></div>';
    }
  }

  // ---------- Commandes ----------
  boardEl.addEventListener('click', function (e) {
    var b = e.target.closest('.cell');
    if (b) onCell(+b.dataset.i);
  });
  undoBtn.addEventListener('click', function () {
    if (!undoStack.length || thinking || mode === 'online') return;
    S = JSON.parse(undoStack.pop());
    while (mode === 'bot' && S.turn !== 0 && undoStack.length) S = JSON.parse(undoStack.pop());
    sel = null; justMoved = false;
    render();
  });
  function reset() {
    S = E.fresh(); undoStack = []; sel = null; justMoved = false; thinking = false;
    render();
  }
  resetBtn.addEventListener('click', function () {
    if (mode === 'online') { leaveOnline(); reset(); return; }
    reset();
  });
  modeBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      if (thinking || b.dataset.mode === mode) return;
      if (mode === 'online') leaveOnline();
      mode = b.dataset.mode;
      lobbyErr = '';
      reset();
    });
  });
  document.getElementById('create').addEventListener('click', function () { lobbyErr = ''; wsSend({ t: 'create' }); });
  document.getElementById('join').addEventListener('click', function () { joinCode(document.getElementById('codein').value); });
  document.getElementById('codein').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') joinCode(e.target.value);
  });
  document.getElementById('copy').addEventListener('click', function () {
    var t = document.getElementById('roomlink').textContent, btn = this;
    try {
      navigator.clipboard.writeText(t).then(function () {
        btn.textContent = 'Copié';
        setTimeout(function () { btn.textContent = 'Copier le lien'; }, 1500);
      }, function () {});
    } catch (e) {}
  });

  // ---------- Démarrage ----------
  var code = new URLSearchParams(location.search).get('partie');
  if (code) { mode = 'online'; joinCode(code); }
  render();
})();
