// Home-button takeover for the Aerial launcher (LG webOS 4.5, Node 0.12, armv7l 32-bit).
// Read-only (no grab): polls every /dev/input/event* non-blocking for HOME (code 773).
//   short press  -> re-foreground our launcher (com.apple.aerial.tvos)
//   hold >= 5s   -> leave the stock home in front. We do not launch it: the key itself
//                   already opens it, so on a hold we only stop re-foregrounding.
// The stock Home opens on the key itself; we can't stop that from userspace without grabbing
// the whole device, so on a short press we re-launch our app a few times to win the
// foreground back after Home has settled (a single immediate launch races and no-ops).
// Also polls /tmp/aerial-homewatch-cmd (write an appId) as a manual launch hook for testing.
var fs = require('fs');
var cp = require('child_process');

var APP = 'com.apple.aerial.tvos';
var HOME_CODE = 773;
var EV_KEY = 1, EV_SIZE = 16, O_NONBLOCK = 2048;
var LUNA = '/usr/bin/luna-send';
var LOG = '/tmp/aerial-homewatch.log';
var CMD = '/tmp/aerial-homewatch-cmd';
var LONG_MS = 5000;

function log(m) { try { fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + m + '\n'); } catch (e) {} }

function luna(id, reason) {
  cp.execFile(LUNA, ['-a', 'webosbrew', '-f', '-n', '1',
    'luna://com.webos.applicationManager/launch', '{"id":"' + id + '"}'],
    function (err, so, se) {
      log('launch ' + id + ' (' + reason + ') err=' + (err ? err.message : '-') +
          ' out=' + String(so).replace(/\s+$/, '') + ' ' + String(se).replace(/\s+$/, ''));
    });
}

// Read which app currently owns the foreground (privileged-only; works from the boot context).
function fg(cb) {
  cp.execFile(LUNA, ['-a', 'webosbrew', '-n', '1',
    'luna://com.webos.applicationManager/getForegroundAppInfo', '{}'],
    function (err, so, se) {
      var id = '';
      try {
        var o = JSON.parse(so);
        id = o.appId || (o.foregroundAppInfo && o.foregroundAppInfo.appId) || '';
      } catch (e) {}
      cb(id, String(so).replace(/\s+$/, '') + ' ' + String(se).replace(/\s+$/, ''));
    });
}

// Re-foreground our app: the stock Home opens on the key and (during its CRIU restore) silently
// ignores launches for a few seconds, so retry every 1s until one lands. Once getForegroundAppInfo
// reports our app on top we stop immediately (fast + no spam); a hard cap of 12 protects us if the
// probe is ever unavailable. The ladder is CANCELLABLE: a new press (or a long-press firing) stops
// it, so a stale ladder can never yank us back out of the stock Home after a later long-press.
var bringBusy = false;
var bringCount = 0;
var bringIv = null;
function stopBring() { if (bringIv) { clearInterval(bringIv); bringIv = null; } bringBusy = false; }
function bringBack() {
  stopBring();
  bringBusy = true;
  bringCount = 0;
  bringIv = setInterval(function () {
    if (!bringBusy) return;
    if (bringCount >= 12) { log('bring cap reached'); stopBring(); return; }
    fg(function (id) {
      if (!bringBusy) return;
      if (id === APP) { log('bring done (fg=' + APP + ')'); stopBring(); return; }
      bringCount++;
      luna(APP, 'bring#' + bringCount);
    });
  }, 1000);
}

// Boot: keep (re)launching our app until it actually owns the foreground. At cold boot webOS
// shows HDMI/Home first and swallows early launches, so a 3-shot autostart is not enough. We
// start almost immediately and probe every 1s so the launch fires the instant webOS can honor it.
var BOOT_UNTIL = Date.now() + 150000;
function bootBring() {
  var iv = null;
  function tick() {
    if (Date.now() > BOOT_UNTIL) { log('boot bring: deadline'); if (iv) clearInterval(iv); return; }
    fg(function (id) {
      if (id === APP) { log('boot bring: launcher is foreground'); if (iv) clearInterval(iv); return; }
      log('boot bring: fg=' + (id || '?') + ' -> launch ' + APP);
      luna(APP, 'boot');
    });
  }
  tick();                          // fire the very first probe/launch immediately
  iv = setInterval(tick, 1000);
}

try { fs.writeFileSync('/tmp/aerial-homewatch.pid', String(process.pid)); } catch (e) {}
log('homewatch start pid=' + process.pid);

var names = {};
try {
  fs.readFileSync('/proc/bus/input/devices', 'utf8').split(/\n\n+/).forEach(function (blk) {
    var m = blk.match(/N: Name="([^"]+)"[\s\S]*?H: Handlers=([^\n]*)/);
    if (m) { (m[2].match(/event\d+/g) || []).forEach(function (e) { names[e] = m[1]; }); }
  });
} catch (e) {}

var fds = {};
fs.readdirSync('/dev/input').filter(function (f) { return /^event\d+$/.test(f); })
  .forEach(function (f) { try { fds[f] = fs.openSync('/dev/input/' + f, 0 | O_NONBLOCK); } catch (e) {} });
log('watching ' + Object.keys(fds).length + ' devices');

var buf = new Buffer(EV_SIZE * 64);
var longTimer = null;
var longFired = false;

function onPress() {
  stopBring();
  longFired = false;
  if (longTimer) { clearTimeout(longTimer); longTimer = null; }
  longTimer = setTimeout(function () {
    longFired = true;
    stopBring();
    log('HOME hold >= ' + (LONG_MS / 1000) + 's -> leave stock home in front');
  }, LONG_MS);
}
function onRelease() {
  if (longTimer) { clearTimeout(longTimer); longTimer = null; }
  if (!longFired) { log('HOME short press -> bring back ' + APP); bringBack(); }
}

setInterval(function () {
  for (var f in fds) {
    var n = 0;
    try { n = fs.readSync(fds[f], buf, 0, buf.length, null); } catch (e) { continue; }
    for (var off = 0; off + EV_SIZE <= n; off += EV_SIZE) {
      var type = buf.readUInt16LE(off + 8);
      var code = buf.readUInt16LE(off + 10);
      var val = buf.readInt32LE(off + 12);
      if (type === EV_KEY && code === HOME_CODE) {
        log('HOME773 dev=' + f + ' val=' + val);
        if (val === 1) onPress();
        else if (val === 0) onRelease();
      }
    }
  }
}, 16);

// Manual hook for testing: echo an appId into CMD to launch it; echo "fg" to dump foreground.
setInterval(function () {
  try {
    if (fs.existsSync(CMD)) {
      var id = ('' + fs.readFileSync(CMD)).trim();
      fs.unlinkSync(CMD);
      if (id === 'fg') {
        fg(function (a, raw) { log('cmd fg -> appId=' + (a || '(none)') + ' raw=' + raw); });
      } else if (id) { log('cmd -> launch ' + id); luna(id, 'cmd'); }
    }
  } catch (e) {}
}, 250);

// Kick off the boot bring loop almost immediately so we catch webOS the moment it can launch.
setTimeout(function () { log('boot bring: start'); bootBring(); }, 1500);
