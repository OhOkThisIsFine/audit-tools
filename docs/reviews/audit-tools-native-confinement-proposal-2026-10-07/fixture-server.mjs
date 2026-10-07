// Owned TCP/UDP echo fixture only; no imports from the candidate.
import net from 'node:net';
import dgram from 'node:dgram';
const tcp = net.createServer(socket => socket.on('data', data => socket.write(data)));
const udp4 = dgram.createSocket('udp4');
const udp6 = dgram.createSocket({type: 'udp6', ipv6Only: true});
for (const socket of [udp4, udp6])
  socket.on('message', (msg, peer) => socket.send(msg, peer.port, peer.address));
await Promise.all([
  new Promise((resolve, reject) => tcp.once('error', reject)
    .listen({host: '::', port: 8090, ipv6Only: false}, resolve)),
  new Promise((resolve, reject) => { udp4.once('error', reject); udp4.bind(8091, '0.0.0.0', resolve); }),
  new Promise((resolve, reject) => { udp6.once('error', reject); udp6.bind(8091, '::', resolve); }),
]);
console.log('R05_FIXTURE_READY');
