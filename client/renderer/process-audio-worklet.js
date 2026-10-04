'use strict';
// Bounded stereo PCM queue. Old audio is dropped if the UI was stalled so that
// a resumed stream never plays seconds of stale sound.
class ProcessAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(24000);this.right = new Float32Array(24000);
    this.read = 0;this.write = 0;this.count = 0;
    this.port.onmessage = ({data}) => {
      const pcm = new Float32Array(data);
      const frames = pcm.length / 2;
      if (this.count + frames > 12000) { this.read=this.write;this.count=0; }
      for (let i=0;i<frames;i++) {
        this.left[this.write]=pcm[i*2];this.right[this.write]=pcm[i*2+1];
        this.write=(this.write+1)%this.left.length;
      }
      this.count+=frames;
    };
  }
  process(_inputs, outputs) {
    const channels=outputs[0];
    for(let i=0;i<channels[0].length;i++) {
      if(this.count) {
        channels[0][i]=this.left[this.read];channels[1][i]=this.right[this.read];
        this.read=(this.read+1)%this.left.length;this.count--;
      } else { channels[0][i]=0;channels[1][i]=0; }
    }
    return true;
  }
}
registerProcessor('quickshare-process-audio',ProcessAudio);
