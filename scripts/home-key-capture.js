// Capture EV_KEY codes from all /dev/input devices (Node 0.12 compatible).
// Usage: node capture.js [seconds]
var fs = require('fs');
var EV_KEY = 1, EV_SIZE = 16, O_NONBLOCK = 2048;
var secs = parseInt(process.argv[2] || '45', 10);

var names = {};
try {
  fs.readFileSync('/proc/bus/input/devices', 'utf8').split(/\n\n+/).forEach(function (blk) {
    var m = blk.match(/N: Name="([^"]+)"[\s\S]*?H: Handlers=([^\n]*)/);
    if (m) { (m[2].match(/event\d+/g) || []).forEach(function (e) { names[e] = m[1]; }); }
  });
} catch (e) {}

var devs = {};
fs.readdirSync('/dev/input').filter(function (f) { return /^event\d+$/.test(f); })
  .forEach(function (f) { try { devs[f] = fs.openSync('/dev/input/' + f, 0 | O_NONBLOCK); } catch (e) {} });
console.log('watching ' + Object.keys(devs).length + ' devices for ' + secs + 's ...');

var buf = new Buffer(EV_SIZE * 64);
var end = Date.now() + secs * 1000;
var t0 = Date.now();
var t = setInterval(function () {
  if (Date.now() > end) { clearInterval(t); console.log('== done =='); process.exit(0); }
  for (var f in devs) {
    var n = 0;
    try { n = fs.readSync(devs[f], buf, 0, buf.length, null); } catch (e) { continue; }
    for (var off = 0; off + EV_SIZE <= n; off += EV_SIZE) {
      var type = buf.readUInt16LE(off + 8);
      var code = buf.readUInt16LE(off + 10);
      var val = buf.readInt32LE(off + 12);
      if (type === EV_KEY) console.log('+' + (Date.now() - t0) + 'ms ' + f + ' [' + (names[f] || '?') + '] code=' + code + ' val=' + val);
    }
  }
}, 16);
