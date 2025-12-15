import { WebSocket } from 'ws';

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testAudio() {
  const url = `ws://localhost:${process.env.PORT ?? 3001}/egress-audio?roomName=smoke&participant=tester&trackId=audio1&sampleRate=48000&channels=1`;
  console.log('Connecting audio ws:', url);
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  // send 200ms of silence at 48k mono s16le => 48000 * 0.2 * 2 bytes
  const bytes = Buffer.alloc(48000 * 2 * 0.2);
  ws.send(bytes);
  await wait(200);
  ws.close();
  console.log('Audio smoke sent');
}

async function testVideo() {
  const url = `ws://localhost:${process.env.PORT ?? 3001}/egress-video?roomName=smoke&participant=tester&trackId=video1&codec=h264`;
  console.log('Connecting video ws:', url);
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  // send some fake bytestream
  ws.send(Buffer.from([0, 0, 0, 1, 103, 66, 0, 30])); // fake SPS start
  ws.send(Buffer.from([0, 0, 0, 1, 104, 206, 60, 128])); // fake PPS
  ws.send(Buffer.from([0, 0, 0, 1, 101, 0, 0, 0])); // fake IDR
  await wait(100);
  ws.close();
  console.log('Video smoke sent');
}

async function main() {
  try {
    await testAudio();
  } catch (e) {
    console.error('Audio smoke failed', e);
  }
  try {
    await testVideo();
  } catch (e) {
    console.error('Video smoke failed', e);
  }
  console.log('Done. Check output folders for files.');
}

main();


