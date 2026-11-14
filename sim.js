/* Steer the Eight: boat and crew physics, drills and coaching hints.
 *
 * This file is pure logic. It has no DOM or drawing code, so the web page
 * renders it and a native iOS app can port it function by function.
 * Units are SI: metres, seconds, kilograms, newtons, radians.
 *
 * Frames
 *   World: x = east, y = north. Heading `psi` is a compass angle:
 *          0 = north, positive = clockwise (toward starboard).
 *   Boat:  x = forward (toward the bow), y = to starboard. This is the usual
 *          ship-maneuvering convention, so yaw rate `r` > 0 means the bow is
 *          swinging to starboard.
 *
 * Seats are numbered from the bow: 1 (bow seat) to 8 (stroke). The boat is
 * rigged the standard way: even seats row on port, odd seats on starboard.
 * Port is the cox's left, starboard the cox's right.
 *
 * The model is simple on purpose. Each blade pushes on the water with a set
 * force curve, the hull resists motion with drag terms, and the rudder makes a
 * side force that grows with speed squared. Constants are tuned so an eight
 * feels plausible (about 4 to 5 m/s at full pressure, a slow spin at a
 * standstill). They are not fitted to measurements of real boats.
 */
(function (root) {
  'use strict';

  const DEG = Math.PI / 180;

  // ---------------------------------------------------------------- constants

  const C = {
    hullLength: 17.6,
    hullHalfBeam: 0.29,
    massX: 870,        // boat, 8 rowers, cox, plus a little water carried along
    massY: 1600,       // moving sideways drags far more water along
    inertia: 25000,    // yaw inertia including water, kg m^2

    // Hull resistance: force = -(quad * |v| + lin) * v
    surgeQuad: 14, surgeLin: 20,
    swayQuad: 1000, swayLin: 80, swayLift: 500, // swayLift scales with forward speed (the fin)
    yawQuad: 40000, yawLin: 300, yawSpeed: 1800, // yawSpeed: a moving boat resists turning more

    // Rudder, under the stern
    rudderX: -8.0,
    rudderLift: 5.4,      // side force per (m/s)^2 at full rudder
    rudderDrag: 2.5,      // extra drag per (m/s)^2 at full rudder
    rudderBackGrip: 0.45, // rudder works worse when the boat moves backwards

    // Oars (sweep)
    pinOffset: 0.85,   // centreline to oarlock pin
    outboard: 2.4,     // pin to centre of the blade
    bladeTip: 2.75,    // pin to blade tip
    inboard: 1.1,      // pin to handle
    catchAngle: 55 * DEG,   // oar angle at the catch, toward the bow
    finishAngle: -35 * DEG, // oar angle at the finish, toward the stern
    bladePeak: 250,    // peak blade force at full pressure, average rower, N
    backFactor: 0.65,  // backing down is weaker than rowing

    // Holding water: blade squared and buried
    holdQuad: 70, holdLin: 60, holdSide: 0.15, holdMax: 220, holdRamp: 2.5,
    // Blades resting flat on the water
    restLin: 1.5,

    coxX: -6.7,
  };

  const SEATS = [];
  for (let n = 1; n <= 8; n++) {
    SEATS.push({
      n,
      side: n % 2 === 0 ? -1 : 1,          // -1 port, +1 starboard
      x: 5.2 - (n - 1) * 1.4,              // fore-aft position of the pin
      name: n === 1 ? 'Bow seat' : n === 8 ? 'Stroke' : n + ' seat',
    });
  }

  const PRESSURE = { light: 0.5, half: 0.72, full: 1.0 };
  const PRESSURE_LABEL = { light: 'light pressure', half: 'half pressure', full: 'full pressure' };

  const GROUPS = [
    { id: 'all', label: 'All eight', seats: [1, 2, 3, 4, 5, 6, 7, 8] },
    { id: 'port', label: 'Port', seats: [2, 4, 6, 8] },
    { id: 'stbd', label: 'Starboard', seats: [1, 3, 5, 7] },
    { id: 'bowPair', label: 'Bow pair', seats: [1, 2] },
    { id: 'sternPair', label: 'Stern pair', seats: [7, 8] },
    { id: 'bowFour', label: 'Bow four', seats: [1, 2, 3, 4] },
    { id: 'middleFour', label: 'Middle four', seats: [3, 4, 5, 6] },
    { id: 'sternFour', label: 'Stern four', seats: [5, 6, 7, 8] },
  ];

  // power: multiplier on blade force. timing: seconds late (+) or early (-).
  const CREW_PRESETS = {
    even: { label: 'Even crew', power: [1, 1, 1, 1, 1, 1, 1, 1], timing: [0, 0, 0, 0, 0, 0, 0, 0] },
    strongStbd: { label: 'Strong starboard', power: [1.12, 0.92, 1.12, 0.92, 1.12, 0.92, 1.12, 0.92], timing: [0, 0, 0, 0, 0, 0, 0, 0] },
    heavy7: { label: 'Heavy 7 seat', power: [1, 1, 1, 1, 1, 1, 1.4, 1], timing: [0, 0, 0, 0, 0, 0, 0, 0] },
    lateBow: { label: 'Late bow pair', power: [1, 1, 1, 1, 1, 1, 1, 1], timing: [0.14, 0.12, 0, 0, 0, 0, 0, 0] },
    novice: { label: 'Novice crew', power: [1.08, 0.9, 1.1, 0.94, 1.0, 1.08, 0.92, 1.0], timing: [0.06, -0.03, 0, 0.05, -0.05, 0.02, 0, 0] },
  };

  function makeCrew(presetId) {
    const p = CREW_PRESETS[presetId] || CREW_PRESETS.even;
    return SEATS.map((_, i) => ({ power: p.power[i], timing: p.timing[i] }));
  }

  // ------------------------------------------------------------------ helpers

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => (1 - Math.cos(Math.PI * t)) / 2;
  const mod = (a, n) => ((a % n) + n) % n;
  const angDiff = (a, b) => mod(a - b + Math.PI, 2 * Math.PI) - Math.PI; // a - b in [-pi, pi)
  const isActive = (q) => q.mode === 'row' || q.mode === 'back';

  // Body frame (x forward, y starboard) to world (east, north).
  function toWorld(s, bx, by) {
    const sp = Math.sin(s.psi), cp = Math.cos(s.psi);
    return { x: s.x + bx * sp + by * cp, y: s.y + bx * cp - by * sp };
  }

  // Nearest point on the river centreline.
  function riverInfo(river, x, y) {
    let best = null, cum = 0;
    const p = river.path;
    for (let i = 0; i < p.length - 1; i++) {
      const ax = p[i][0], ay = p[i][1], bx = p[i + 1][0], by = p[i + 1][1];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy, len = Math.sqrt(len2);
      const t = clamp(((x - ax) * dx + (y - ay) * dy) / len2, 0, 1);
      const qx = ax + t * dx, qy = ay + t * dy;
      const d = Math.hypot(x - qx, y - qy);
      if (!best || d < best.dist) {
        // signed: positive when the point is east of the line (to the right going downstream)
        const side = Math.sign(dx * (y - ay) - dy * (x - ax)) * -1;
        best = { dist: d, along: cum + t * len, dir: Math.atan2(dx, dy), side };
      }
      cum += len;
    }
    best.total = cum;
    return best;
  }

  function riverPointAt(river, along) {
    const p = river.path;
    let cum = 0;
    for (let i = 0; i < p.length - 1; i++) {
      const ax = p[i][0], ay = p[i][1], bx = p[i + 1][0], by = p[i + 1][1];
      const len = Math.hypot(bx - ax, by - ay);
      if (along <= cum + len || i === p.length - 2) {
        const t = clamp((along - cum) / len, 0, 1);
        return { x: ax + t * (bx - ax), y: ay + t * (by - ay), dir: Math.atan2(bx - ax, by - ay) };
      }
      cum += len;
    }
    return null;
  }

  // Points used for collisions: hull outline and the eight blade tips.
  function boatPoints(s) {
    const L = C.hullLength / 2, b = C.hullHalfBeam;
    const pts = [
      { ...toWorld(s, L, 0), label: 'bow', kind: 'hull' },
      { ...toWorld(s, -L, 0), label: 'stern', kind: 'hull' },
      { ...toWorld(s, 4, b * 0.8), label: 'hull', kind: 'hull' },
      { ...toWorld(s, 4, -b * 0.8), label: 'hull', kind: 'hull' },
      { ...toWorld(s, -4, b * 0.8), label: 'hull', kind: 'hull' },
      { ...toWorld(s, -4, -b * 0.8), label: 'hull', kind: 'hull' },
    ];
    for (let i = 0; i < 8; i++) {
      const seat = SEATS[i], a = s.seats[i].angle;
      const bx = seat.x + C.bladeTip * Math.sin(a);
      const by = seat.side * (C.pinOffset + C.bladeTip * Math.cos(a));
      pts.push({ ...toWorld(s, bx, by), label: seat.name + "'s blade", kind: 'blade', seat: seat.n });
    }
    return pts;
  }

  // -------------------------------------------------------------------- state

  function createState(drill) {
    const st = drill.start;
    const s = {
      t: 0,
      x: st.x || 0, y: st.y || 0, psi: st.psi || 0,
      u: st.u || 0, v: 0, r: 0,
      delta: 0,                 // rudder, -1 (full port) to +1 (full starboard)
      rate: st.rate || 22, targetRate: st.rate || 22,
      phase: 0,                 // stroke cycle, 0 = catch
      seats: SEATS.map(() => ({
        mode: 'easy', pending: null, pressure: st.pressure || 'half',
        angle: 0, ph: 0, inWater: false, force: 0, holdT: 0, avgN: 0,
      })),
      avg: { Ncrew: 0, Nrud: 0, Xrud: 0, Xhull: 0, fPort: 0, fStbd: 0 },
      stats: { rudderTime: 0, rowTime: 0, minClear: Infinity },
      events: [],
      status: 'run',            // 'run' | 'win' | 'fail'
      result: null,
    };
    if (st.rowing) {
      s.seats.forEach((q) => { q.mode = 'row'; q.angle = C.catchAngle; });
    }
    return s;
  }

  // Apply a cox's call to some seats. mode: 'row' | 'back' | 'hold' | 'easy'.
  function command(s, crew, seatNums, mode) {
    const anyActive = s.seats.some(isActive);
    const startFresh = !anyActive && (mode === 'row' || mode === 'back');
    const cycle = 60 / s.rate;
    if (startFresh) s.phase = 0;
    for (const n of seatNums) {
      const q = s.seats[n - 1];
      if (mode === 'hold') {
        if (q.mode !== 'hold') { q.mode = 'hold'; q.holdT = 0; }
        q.pending = null;
      } else if (mode === 'easy') {
        // Rowers finish the stroke they are on, then stop.
        if (isActive(q) && q.inWater) q.pending = 'easy';
        else { q.mode = 'easy'; q.pending = null; }
      } else {
        if (q.mode === mode) { q.pending = null; continue; }
        if (startFresh) {
          q.mode = mode; q.pending = null;
          q.ph = mod(-crew[n - 1].timing / cycle, 1);
        } else {
          q.pending = mode; // joins in at the next catch
        }
      }
    }
  }

  function setPressure(s, seatNums, level) {
    for (const n of seatNums) s.seats[n - 1].pressure = level;
  }

  // ---------------------------------------------------------------- physics

  function step(s, crew, dt) {
    const cycle = 60 / s.rate;
    const driveT = clamp(1.25 - 0.015 * s.rate, 0.68, 1.0);
    const driveFrac = Math.min(0.6, driveT / cycle);

    s.phase += dt / cycle;
    if (s.phase >= 1) {
      s.phase -= 1;
      // "Up two in two": the rate changes by one stroke per minute each stroke.
      if (s.targetRate !== s.rate) s.rate += Math.sign(s.targetRate - s.rate);
    }

    let X = 0, Y = 0, N = 0, Ncrew = 0, fPort = 0, fStbd = 0;
    const kAvg = 1 - Math.exp(-dt / 2.5);

    for (let i = 0; i < 8; i++) {
      const seat = SEATS[i], q = s.seats[i], rower = crew[i];
      const ph = mod(s.phase - rower.timing / cycle, 1);
      const wrapped = ph < q.ph - 0.5; // this rower just reached the catch
      q.ph = ph;

      if (q.pending) {
        if ((q.pending === 'row' || q.pending === 'back') && wrapped) { q.mode = q.pending; q.pending = null; }
        else if (q.pending === 'easy' && (!isActive(q) || ph >= driveFrac)) { q.mode = 'easy'; q.pending = null; }
      }

      let target = 0, f = 0, inWater = false, fx = 0, fy = 0, bx = 0, by = 0, follow = 1.6;

      if (isActive(q)) {
        const dir = q.mode === 'row' ? 1 : -1;
        const peak = C.bladePeak * PRESSURE[q.pressure] * rower.power * (dir < 0 ? C.backFactor : 1);
        const a0 = dir > 0 ? C.catchAngle : C.finishAngle;
        const a1 = dir > 0 ? C.finishAngle : C.catchAngle;
        if (ph < driveFrac) {
          const td = ph / driveFrac;
          target = lerp(a0, a1, ease(td));
          f = peak * Math.sin(Math.PI * td);
          inWater = true;
        } else {
          const tr = (ph - driveFrac) / (1 - driveFrac);
          target = lerp(a1, a0, ease(tr));
        }
        // Blade force is normal to the shaft: forward and inward at the catch.
        const ct = Math.cos(target), st = Math.sin(target);
        fx = dir * f * ct;
        fy = -dir * seat.side * f * st;
        bx = seat.x + C.outboard * st;
        by = seat.side * (C.pinOffset + C.outboard * ct);
        follow = 8;
      } else if (q.mode === 'hold') {
        q.holdT += dt;
        const depth = Math.min(1, q.holdT / C.holdRamp);
        target = 0; inWater = true; follow = 3;
        bx = seat.x + C.outboard * Math.sin(q.angle);
        by = seat.side * (C.pinOffset + C.outboard * Math.cos(q.angle));
        const vx = s.u - s.r * by, vy = s.v + s.r * bx; // blade velocity through the water
        fx = -(C.holdQuad * Math.abs(vx) + C.holdLin) * vx * depth;
        fy = -(C.holdQuad * Math.abs(vy) + C.holdLin) * vy * depth * C.holdSide;
        const mag = Math.hypot(fx, fy), cap = C.holdMax * depth;
        if (mag > cap) { fx *= cap / mag; fy *= cap / mag; }
        f = Math.hypot(fx, fy);
      } else {
        // Easy: blades resting flat on the water. A rower waiting to join
        // comes forward to the catch (or the finish, for backing).
        target = q.pending === 'row' ? C.catchAngle : q.pending === 'back' ? C.finishAngle : 0;
        bx = seat.x + C.outboard * Math.sin(q.angle);
        by = seat.side * (C.pinOffset + C.outboard * Math.cos(q.angle));
        const vx = s.u - s.r * by, vy = s.v + s.r * bx;
        fx = -C.restLin * vx; fy = -C.restLin * vy;
      }

      // Blade leaves the water at the finish: leave a puddle behind.
      if (q.inWater && !inWater && isActive(q)) {
        const w = toWorld(s, bx, by);
        s.events.push({ type: 'puddle', x: w.x, y: w.y, seat: seat.n });
      }
      q.inWater = inWater;
      q.force = f;

      const maxStep = follow * dt;
      q.angle += clamp(target - q.angle, -maxStep, maxStep);

      const n = bx * fy - by * fx;
      X += fx; Y += fy; N += n; Ncrew += n;
      q.avgN += (n - q.avgN) * kAvg;
      if (seat.side < 0) fPort += fx; else fStbd += fx;
    }

    // Rudder
    const u = s.u, v = s.v, r = s.r;
    const grip = u >= 0 ? 1 : C.rudderBackGrip;
    const Yr = -C.rudderLift * u * Math.abs(u) * s.delta * grip;
    const Xr = -C.rudderDrag * u * Math.abs(u) * s.delta * s.delta;
    const Nr = C.rudderX * Yr;
    X += Xr; Y += Yr; N += Nr;

    // Hull
    const Xh = -(C.surgeQuad * Math.abs(u) + C.surgeLin) * u;
    const Yh = -(C.swayQuad * Math.abs(v) + C.swayLin + C.swayLift * Math.abs(u)) * v;
    const Nh = -(C.yawQuad * Math.abs(r) + C.yawLin + C.yawSpeed * Math.abs(u)) * r;
    X += Xh; Y += Yh; N += Nh;

    // Equations of motion in the boat frame (semi-implicit Euler)
    s.u += ((X + C.massY * v * r) / C.massX) * dt;
    s.v += ((Y - C.massX * u * r) / C.massY) * dt;
    s.r += (N / C.inertia) * dt;

    s.psi += s.r * dt;
    const sp = Math.sin(s.psi), cp = Math.cos(s.psi);
    s.x += (s.u * sp + s.v * cp) * dt;
    s.y += (s.u * cp - s.v * sp) * dt;
    s.t += dt;

    const a = s.avg;
    a.Ncrew += (Ncrew - a.Ncrew) * kAvg;
    a.Nrud += (Nr - a.Nrud) * kAvg;
    a.Xrud += (Xr - a.Xrud) * kAvg;
    a.Xhull += (Xh - a.Xhull) * kAvg;
    a.fPort += (fPort - a.fPort) * kAvg;
    a.fStbd += (fStbd - a.fStbd) * kAvg;

    if (s.seats.some(isActive)) {
      s.stats.rowTime += dt;
      s.stats.rudderTime += Math.abs(s.delta) * dt;
    }
  }

  // ------------------------------------------------------------------ drills

  function fail(title, text) { return { status: 'fail', title, text }; }
  function win(title, text) { return { status: 'win', title, text }; }
  const speedOf = (s) => Math.hypot(s.u, s.v);

  function fmtTime(t) {
    const m = Math.floor(t / 60), sec = t - m * 60;
    return m + ':' + (sec < 10 ? '0' : '') + sec.toFixed(1);
  }

  function bankHit(s, drill) {
    const half = drill.river.width / 2;
    for (const p of boatPoints(s)) {
      if (p.kind !== 'hull') continue;
      if (riverInfo(drill.river, p.x, p.y).dist > half) return p;
    }
    return null;
  }

  function inRect(p, r) { return p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1; }

  function bridgeSolids(b) {
    return b.solids.map((sd) => sd.kind === 'pier'
      ? { x0: sd.x0, x1: sd.x1, y0: b.y - 2, y1: b.y + b.depth + 1, kind: 'pier' }
      : { x0: sd.x0, x1: sd.x1, y0: b.y - 1.2, y1: b.y - 0.6, kind: 'closed' });
  }

  const DRILLS = [
    {
      id: 'free',
      name: 'Free row',
      goal: 'Row down the river. Try the rudder at different speeds, then try turning with only one side rowing.',
      hint: 'Pick a group, then make a call. "All eight, row" gets you moving.',
      crew: 'even',
      river: { width: 46, path: [[0, -120], [0, 320], [50, 480], [50, 760], [-30, 980], [-30, 1250], [20, 1450], [20, 1900]] },
      start: { x: 0, y: 0, psi: 0, rate: 22, pressure: 'half' },
      objects: [],
      course(s) { return riverInfo(this.river, s.x, s.y).dir; },
      progress(s) {
        const ri = riverInfo(this.river, s.x, s.y);
        return Math.max(0, Math.round(ri.along - 120)) + ' m down the river';
      },
      check(s) {
        const hit = bankHit(s, this);
        const ri = riverInfo(this.river, s.x, s.y);
        if (hit) return fail('Aground', 'The ' + hit.label + ' hit the bank ' + Math.max(0, Math.round(ri.along - 120)) + ' m down the river.');
        if (ri.along > ri.total - 40) return win('End of the river', 'You rowed the whole stretch in ' + fmtTime(s.t) + '.');
        return null;
      },
    },
    {
      id: 'straight',
      name: 'Hold your line',
      goal: 'Starboard is stronger than port today. Keep the boat inside the buoys to the 500 m finish.',
      hint: 'Watch which way the bow drifts and steer against it early. Small, steady rudder beats big corrections.',
      crew: 'strongStbd',
      river: { width: 70, path: [[0, -150], [0, 750]] },
      start: { x: 0, y: 0, psi: 0, u: 3.5, rate: 24, pressure: 'half', rowing: true },
      objects: [
        { type: 'buoys', xs: [-6.75, 6.75], y0: 0, y1: 500, step: 10 },
        { type: 'line', y: 0, x0: -6.75, x1: 6.75, label: 'Start' },
        { type: 'line', y: 500, x0: -6.75, x1: 6.75, label: 'Finish' },
      ],
      course() { return 0; },
      progress(s) { return Math.round(Math.max(0, s.y + C.hullLength / 2)) + ' of 500 m'; },
      check(s) {
        for (const p of boatPoints(s)) {
          if (p.kind === 'hull' && Math.abs(p.x) > 6.75 && p.y > 0 && p.y < 500) {
            const side = p.x < 0 ? 'port' : 'starboard';
            return fail('Out of the lane', 'The boat crossed the ' + side + ' buoy line at ' + Math.round(p.y) + ' m.');
          }
        }
        if (s.y + C.hullLength / 2 >= 500) {
          const rud = Math.round(100 * s.stats.rudderTime / Math.max(1, s.stats.rowTime));
          const tip = rud > 25 ? ' That much rudder slows the boat. Correct earlier, with smaller moves.' : ' Nice, light steering.';
          return win('Finished', '500 m in ' + fmtTime(s.t) + ', with ' + rud + '% rudder on average.' + tip);
        }
        return null;
      },
    },
    {
      id: 'spin',
      name: 'Spin the boat',
      goal: 'Turn the boat to face downstream (180°) without touching either bank, then stop the turn.',
      hint: 'The rudder does nothing at a standstill. Try Port: Row, then Starboard: Back it down.',
      crew: 'even',
      river: { width: 40, path: [[0, -200], [0, 200]] },
      start: { x: 0, y: 0, psi: 0, rate: 20, pressure: 'light' },
      objects: [{ type: 'arrow', y: -30, label: 'Downstream' }],
      course() { return Math.PI; },
      progress(s) {
        const off = Math.abs(angDiff(s.psi, Math.PI)) / DEG;
        return off < 10 ? 'Facing downstream. Now stop the turn.' : Math.round(off) + '° to go';
      },
      check(s) {
        const hit = bankHit(s, this);
        if (hit) return fail('Aground', 'The ' + hit.label + ' hit the bank.');
        const off = Math.abs(angDiff(s.psi, Math.PI));
        if (off < 10 * DEG && Math.abs(s.r) < 2 * DEG && speedOf(s) < 1) {
          return win('Turned around', 'The boat faces downstream after ' + fmtTime(s.t) + '.');
        }
        return null;
      },
    },
    {
      id: 'stop',
      name: 'Stop short',
      goal: 'Your crew is at full pressure. Stop the boat as close to the fallen tree as you can without hitting it.',
      hint: '"Weigh enough" lets the boat glide a long way. "Hold water" stops it within a couple of boat lengths.',
      crew: 'even',
      river: { width: 50, path: [[0, -150], [0, 400]] },
      start: { x: 0, y: 0, psi: 0, u: 4.6, rate: 30, pressure: 'full', rowing: true },
      treeY: 230,
      objects: [{ type: 'tree', y: 230 }],
      course() { return 0; },
      progress(s) {
        const bow = s.y + C.hullLength / 2;
        return Math.max(0, Math.round(this.treeY - bow)) + ' m to the tree';
      },
      check(s) {
        const hit = bankHit(s, this);
        if (hit) return fail('Aground', 'The ' + hit.label + ' hit the bank.');
        let front = -Infinity, who = 'bow';
        for (const p of boatPoints(s)) if (p.y > front) { front = p.y; who = p.label; }
        if (front >= this.treeY - 0.5) return fail('Hit the tree', 'The ' + who + ' hit the tree at ' + speedOf(s).toFixed(1) + ' m/s.');
        if (s.t > 2 && speedOf(s) < 0.3) {
          const gap = this.treeY - 0.5 - front;
          const g = Math.round(gap);
          if (gap <= 15) return win('Spot on', 'Stopped ' + g + ' m short of the tree.');
          if (gap <= 40) return win('Good stop', 'Stopped ' + g + ' m short of the tree. Try letting it run a little longer.');
          return win('Safe, but early', 'Stopped ' + g + ' m short. You can keep rowing much closer before you call it.');
        }
        return null;
      },
    },
    {
      id: 'arch',
      name: 'Through the arch',
      goal: 'Only the left arch of the bridge is open. Line the boat up and take it through without a blade touching stone.',
      hint: 'Line up early, while you have speed for the rudder to work. Then keep the boat straight through the arch.',
      crew: 'novice',
      river: { width: 50, path: [[0, -150], [0, 500]] },
      start: { x: 0, y: 0, psi: 0, u: 3.5, rate: 24, pressure: 'half', rowing: true },
      bridge: {
        y: 200, depth: 7,
        solids: [
          { x0: -30, x1: -19.5, kind: 'pier' },
          { x0: -8.5, x1: -5, kind: 'pier' },
          { x0: -5, x1: 5, kind: 'closed' },
          { x0: 5, x1: 8.5, kind: 'pier' },
          { x0: 8.5, x1: 19.5, kind: 'closed' },
          { x0: 19.5, x1: 30, kind: 'pier' },
        ],
        open: [{ x0: -19.5, x1: -8.5 }],
      },
      objects: [{ type: 'bridge' }],
      course() { return 0; },
      progress(s) {
        const bow = s.y + C.hullLength / 2, b = this.bridge;
        if (bow < b.y) return Math.round(b.y - bow) + ' m to the bridge';
        return 'Under the bridge';
      },
      check(s) {
        const hit = bankHit(s, this);
        if (hit) return fail('Aground', 'The ' + hit.label + ' hit the bank.');
        const b = this.bridge, solids = bridgeSolids(b);
        const pts = boatPoints(s);
        for (const p of pts) {
          for (const r of solids) {
            if (inRect(p, r)) {
              const what = r.kind === 'pier' ? 'a bridge pier' : 'the barrier across a closed arch';
              const who = p.kind === 'blade' ? p.label : 'the ' + p.label;
              return fail('Hit the bridge', who.charAt(0).toUpperCase() + who.slice(1) + ' hit ' + what + '.');
            }
          }
        }
        // Track the closest call while any part of the boat is under the bridge.
        for (const p of pts) {
          if (p.y < b.y - 2 || p.y > b.y + b.depth + 1) continue;
          for (const r of solids) {
            if (r.kind !== 'pier') continue;
            const dx = p.x < r.x0 ? r.x0 - p.x : p.x > r.x1 ? p.x - r.x1 : 0;
            s.stats.minClear = Math.min(s.stats.minClear, dx);
          }
        }
        if (s.y - C.hullLength / 2 > b.y + b.depth + 2) {
          const c = isFinite(s.stats.minClear) ? s.stats.minClear : 0;
          return win('Through the arch', 'Clean passage, with ' + c.toFixed(1) + ' m to spare at the closest point.');
        }
        return null;
      },
    },
  ];

  function update(s, crew, drill, dt) {
    if (s.status !== 'run') return;
    step(s, crew, dt);
    const res = drill.check(s);
    if (res) { s.status = res.status; s.result = res; }
  }

  // ---------------------------------------------------------------- coaching

  const sideName = (sgn) => (sgn > 0 ? 'starboard' : 'port');
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  // Estimated seconds per 500 m lost to rudder drag at the current speed.
  function rudderCost(s) {
    if (s.u < 0.8) return 0;
    const ratio = Math.abs(s.avg.Xrud) / Math.max(1, Math.abs(s.avg.Xhull));
    return (500 / s.u) * (Math.sqrt(1 + ratio) - 1);
  }

  // One plain sentence on why the boat is doing what it is doing.
  function explain(s, crew) {
    if (s.status !== 'run') return '';
    const seats = s.seats;
    const speed = s.u;
    const modeOf = (side) => seats.filter((q, i) => SEATS[i].side === side).map((q) => q.mode);
    const port = modeOf(-1), stbd = modeOf(1);
    const count = (arr, m) => arr.filter((x) => x === m).length;
    const holdP = count(port, 'hold'), holdS = count(stbd, 'hold');
    const active = seats.filter(isActive).length;
    const turnDeg = s.r / DEG;
    const Nc = s.avg.Ncrew, Nr = s.avg.Nrud;

    if (Math.abs(speed) > 1.8 && holdP !== holdS) {
      const side = holdP > holdS ? 'port' : 'starboard';
      return 'Holding water on ' + side + ' at speed slews the bow hard to ' + side + '. At speed, hold both sides and ease the blades in.';
    }
    if (holdP + holdS === 8) {
      return Math.abs(speed) > 0.3
        ? 'All eight are holding water. The squared blades act as brakes and stop the boat within a couple of lengths.'
        : 'All eight are holding water, so the boat stays put.';
    }
    if (Math.abs(s.delta) > 0.15 && Math.abs(speed) < 0.6 && active === 0) {
      return 'The rudder does nothing when the boat is barely moving. Turn with the rowers: one side rows while the other backs.';
    }
    if (Math.abs(s.delta) > 0.15 && speed < -0.4) {
      return 'The boat is going backwards, so the rudder steers the opposite way and has little grip.';
    }

    // Turning caused by the crew
    if (Math.abs(Nc) > 70 && active + holdP + holdS > 0) {
      const turnSide = sideName(Nc);
      const rowP = count(port, 'row'), rowS = count(stbd, 'row');
      const backP = count(port, 'back'), backS = count(stbd, 'back');
      let msg;
      if ((rowP && (backS || holdS)) || (rowS && (backP || holdP))) {
        const rowSide = rowP > rowS ? 'Port' : 'Starboard';
        const other = rowSide === 'Port' ? 'starboard' : 'port';
        const verb = (backP || backS) ? 'backs' : 'holds water';
        msg = rowSide + ' rows while ' + other + ' ' + verb + ', so the boat pivots to ' + turnSide + '.';
      } else if (rowP + backP === 0 && rowS + backS > 0) {
        msg = 'Only starboard is ' + (backS ? 'backing' : 'rowing') + ', so the bow swings to ' + turnSide + '.';
      } else if (rowS + backS === 0 && rowP + backP > 0) {
        msg = 'Only port is ' + (backP ? 'backing' : 'rowing') + ', so the bow swings to ' + turnSide + '.';
      } else {
        // Everyone rowing: find whoever pulls harder than their side-mates.
        let standout = null, best = 1.2;
        for (const side of [-1, 1]) {
          const idx = SEATS.map((st, i) => i).filter((i) => SEATS[i].side === side && isActive(seats[i]));
          if (idx.length < 2) continue;
          const mean = idx.reduce((t, i) => t + crew[i].power, 0) / idx.length;
          for (const i of idx) {
            const ratio = crew[i].power / mean;
            if (ratio > best) { best = ratio; standout = i; }
          }
        }
        if (standout !== null) {
          msg = SEATS[standout].name + ' is pulling harder than the rest, so the bow swings to ' + turnSide + '.';
        } else {
          const strong = Nc > 0 ? 'Port' : 'Starboard';
          const weak = Nc > 0 ? 'starboard' : 'port';
          msg = strong + ' is pulling harder than ' + weak + ', so the bow swings to ' + turnSide + '.';
        }
      }
      if (Math.abs(Nr) > 0.5 * Math.abs(Nc) && Math.sign(Nr) !== Math.sign(Nc)) {
        const cost = rudderCost(s);
        msg += ' Your rudder is holding it' + (cost >= 0.5 ? ', at a cost of about ' + cost.toFixed(1) + ' s per 500 m.' : '.');
      }
      return msg;
    }

    if (Math.abs(Nr) > 70) {
      const side = sideName(Nr);
      const cost = rudderCost(s);
      return 'Rudder to ' + side + ' is turning the bow to ' + side + '.' + (cost >= 0.5 ? ' It costs about ' + cost.toFixed(1) + ' s per 500 m.' : '');
    }

    if (active > 0) {
      const late = seats.map((q, i) => i).filter((i) => isActive(seats[i]) && Math.abs(crew[i].timing) >= 0.08);
      if (late.length) {
        const names = late.map((i) => SEATS[i].name);
        const word = crew[late[0]].timing > 0 ? 'late' : 'early';
        const list = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
        return cap(list) + (names.length === 1 ? ' is ' : ' are ') + word + ' at the catch, so the bow kicks a little on every stroke.';
      }
      if (Math.abs(turnDeg) < 0.6) return 'Both sides are pulling evenly, so the boat runs straight.';
      return 'The boat is still turning from your last correction. It takes a few strokes to settle.';
    }

    if (Math.abs(speed) > 0.3) return 'Nobody is rowing. The boat glides on and slowly loses speed.';
    return 'The boat is sitting still. Choose who rows, then make a call.';
  }

  const api = {
    C, SEATS, PRESSURE, PRESSURE_LABEL, GROUPS, CREW_PRESETS, DRILLS, DEG,
    makeCrew, createState, command, setPressure, step, update, explain,
    boatPoints, riverInfo, riverPointAt, bridgeSolids, toWorld, angDiff, fmtTime, isActive,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EightSim = api;
})(typeof window !== 'undefined' ? window : this);
