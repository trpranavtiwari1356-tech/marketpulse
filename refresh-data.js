// MarketPulse — data snapshot refresh (run on the LOCAL machine, not the cloud host).
//
// Why this exists: two different feeds cannot be fetched on the deployed host's request path.
//   • NSE blocks the deployed host's IP outright, so bhavcopy / FII-DII / deals / results-calendar
//     can never be fetched there at all.
//   • The Macro Maps pull (World Bank WDI + IMF WEO) is ~800 KB and ~15s per indicator — fine in
//     a background sweep, far too slow to build from scratch while a visitor waits.
// Git is the transport for both: this script warms the caches from a residential IP, prunes the
// bhavcopy window, and stages the result to be committed and pushed. Render redeploys and serves
// fresh data immediately, then keeps macro topped up on its own background schedule.
//
//   node refresh-data.js            warm + prune + stage, then stop (review, commit yourself)
//   node refresh-data.js --commit   also commit
//   node refresh-data.js --push     also commit and push (live site updates)
//
// Yahoo-derived caches are deliberately NOT touched: the cloud host fetches those fine on its
// own, so committing them would be pure repo bloat.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '.cache');
const PORT = 5199;                     // spare port, so a server you already have open is untouched
// Trading days to retain. The delivery engine reads 26, but ensureBhavDays() probes a wider
// lookback, so keeping only 26-30 means a normal server run keeps re-creating files this script
// just deleted. 40 covers the probe window and stops that churn.
const BHAV_KEEP = 40;
const BOOT_TIMEOUT_MS = 90000;

const args = process.argv.slice(2);
const DO_COMMIT = args.includes('--commit') || args.includes('--push');
const DO_PUSH = args.includes('--push');

// Endpoints that force an upstream fetch. Order matters: bhavcopy is the slow one, so it goes
// first and the rest warm while it is still filling. `warm=1` on the macro routes tells the
// server to block until the rebuild lands instead of answering from the cache we mean to replace.
const WARM = [
  ['/api/delivery-spikes?uni=Nifty%20500', 'bhavcopy delivery history (26 trading days)'],
  ['/api/fii-dii', 'FII/DII flows'],
  ['/api/deals', 'bulk & block deals'],
  ['/api/earnings-calendar', 'results calendar'],
  // Macro Maps (World Bank WDI + IMF WEO via DBnomics). Not IP-blocked like NSE, but each
  // indicator is a ~800 KB / 15s pull that the free tier cannot do on a request path — so the
  // snapshots ship via git too and the deployed server only has to keep them topped up.
  ['/api/macro?ind=inflation&warm=1',    'macro · inflation'],
  ['/api/macro?ind=gdp&warm=1',          'macro · GDP growth'],
  ['/api/macro?ind=unemployment&warm=1', 'macro · unemployment'],
  ['/api/macro?ind=debt&warm=1',         'macro · govt debt'],
  ['/api/macro?ind=cab&warm=1',          'macro · current account'],
  ['/api/macro?ind=interest&warm=1',     'macro · lending rate'],
  ['/api/macro?ind=currency&warm=1',     'macro · currency vs USD'],
  ['/api/macro?ind=renew_energy&warm=1', 'macro · renewables'],
  ['/api/macro-geo',              'world map geometry'],
];

const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForServer(proc) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error('server exited during boot (code ' + proc.exitCode + ')');
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/indices`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return;
    } catch { /* not listening yet */ }
    await sleep(1000);
  }
  throw new Error('server did not come up within ' + BOOT_TIMEOUT_MS / 1000 + 's');
}

// Keep only the newest BHAV_KEEP bhavcopy files. Filenames are DDMMYYYY, which does not sort
// chronologically as text, so parse the date out rather than sorting the raw name.
function pruneBhav() {
  const files = fs.readdirSync(DIR).filter(f => /^bhav_\d{8}\.json$/.test(f));
  const dated = files.map(f => {
    const k = f.slice(5, 13);
    return { f, t: Date.UTC(+k.slice(4), +k.slice(2, 4) - 1, +k.slice(0, 2)) };
  }).sort((a, b) => b.t - a.t);
  const drop = dated.slice(BHAV_KEEP);
  for (const d of drop) fs.unlinkSync(path.join(DIR, d.f));
  return { kept: Math.min(dated.length, BHAV_KEEP), dropped: drop.length };
}

function git(...a) {
  return execFileSync('git', a, { cwd: __dirname, encoding: 'utf8' }).trim();
}

(async function main() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

  log('Starting a local server on port ' + PORT + ' (full NSE access)…');
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), RENDER: '', LIGHT_START: '' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  let failed = 0;
  try {
    await waitForServer(proc);
    log('Server up. Warming NSE + macro caches…\n');

    for (const [route, label] of WARM) {
      const t0 = Date.now();
      process.stdout.write('  · ' + label + ' … ');
      try {
        // These scans are slow on a cold cache (the Nifty-500 delivery pass walks 26 days).
        const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { signal: AbortSignal.timeout(600000) });
        const body = await r.json().catch(() => null);
        if (!r.ok || (body && body.error)) throw new Error((body && body.error) || 'HTTP ' + r.status);
        log('ok (' + ((Date.now() - t0) / 1000).toFixed(0) + 's)');
      } catch (e) {
        failed++;
        log('FAILED — ' + e.message);
      }
    }

    // segment filings write on a 30s-delayed timer after boot; give the disk writes a beat
    await sleep(3000);
  } finally {
    proc.kill();
  }

  log('\nPruning bhavcopy window…');
  const { kept, dropped } = pruneBhav();
  log(`  kept ${kept} most recent, removed ${dropped} older`);

  // Stage only the cache snapshots — never `git add -A`, which would sweep in unrelated edits.
  log('\nStaging snapshots…');
  git('add', '--', '.cache/');
  const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  if (!staged.length) {
    log('  nothing changed — snapshots already current.');
    return;
  }
  log('  ' + staged.length + ' file(s) staged:');
  for (const f of staged.slice(0, 12)) log('    ' + f);
  if (staged.length > 12) log('    … and ' + (staged.length - 12) + ' more');

  if (failed) log('\n' + failed + ' feed(s) failed — snapshot is partial. Check before pushing.');

  if (!DO_COMMIT) {
    log('\nStaged only. Commit yourself, or re-run with --commit / --push.');
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  git('commit', '-m', `Refresh data snapshots (${stamp})`);
  log('\nCommitted.');

  if (DO_PUSH) {
    log('Pushing…');
    git('push');
    log('Pushed — the live site will pick this up on its next deploy.');
  } else {
    log('Not pushed (use --push to publish to the live site).');
  }
})().catch(e => { console.error('\nrefresh-data failed: ' + e.message); process.exit(1); });
