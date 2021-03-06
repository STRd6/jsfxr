// Synthesize an AudioBuffer from the param data
module.exports = (function() {
  // Sound generation parameters are on [0,1] unless noted SIGNED & thus on [-1,1]
  function Params() {
    // Wave shape
    this.shape = 0;

    // Envelope
    this.attack = 0;    // Attack time
    this.sustain = 0.3; // Sustain time
    this.punch = 0;     // Sustain punch
    this.decay = 0.4;   // Decay time

    // Tone
    this.freq = 0.3;    // Start frequency
    this.freqLimit = 0;   // Min frequency cutoff
    this.freqSlide = 0;    // Slide (SIGNED)
    this.freqSlideDelta = 0;   // Delta slide (SIGNED)
    // Vibrato
    this.vibDepth = 0; // Vibrato depth
    this.vibSpeed = 0;    // Vibrato speed

    // Tonal change
    this.arpMod = 0;      // Change amount (SIGNED)
    this.arpSpeed = 0;    // Change speed

    // Square wave duty (proportion of time signal is high vs. low)
    this.duty = 0;         // Square duty
    this.dutySweep = 0;    // Duty sweep (SIGNED)

    // Repeat
    this.repeatSpeed = 0; // Repeat speed

    // Flanger
    this.flangerOffset = 0;   // Flanger offset (SIGNED)
    this.flangerSweep = 0;     // Flanger sweep (SIGNED)

    // Low-pass filter
    this.lpf = 1;     // Low-pass filter cutoff
    this.lpfSweep = 0;     // Low-pass filter cutoff sweep (SIGNED)
    this.lpfResonance = 0;// Low-pass filter resonance
    // High-pass filter
    this.hpf = 0;     // High-pass filter cutoff
    this.hpfSweep = 0;     // High-pass filter cutoff sweep (SIGNED)

    // Sample parameters
    this.vol = 0.5;
  }

  function FXZ(ps, audioContext) {
    // Handle binary format
    if (ps instanceof ArrayBuffer) {
      ps = Serializer.deserialize(ps, new Params());
    }

    var m = Math;
    var floor = m.floor,
      pow = m.pow,
      abs = m.abs,
      random = m.random;

    var SQUARE = 0,
      SAWTOOTH = 1,
      SINE = 2,
      NOISE = 3,
      OVERSAMPLING = 8,
      sampleRate = 44100;

    var i,
      elapsedSinceRepeat,
      period,
      periodMax,
      enableFrequencyCutoff,
      periodMult,
      periodMultSlide,
      dutyCycle,
      dutyCycleSlide,
      arpeggioMultiplier,
      arpeggioTime;

    function initForRepeat() {
      elapsedSinceRepeat = 0;

      period = 100 / (ps.freq * ps.freq + 0.001);
      periodMax = 100 / (ps.freqLimit * ps.freqLimit + 0.001);
      enableFrequencyCutoff = (ps.freqLimit > 0);
      periodMult = 1 - pow(ps.freqSlide, 3) * 0.01;
      periodMultSlide = -pow(ps.freqSlideDelta, 3) * 0.000001;

      dutyCycle = 0.5 - ps.duty * 0.5;
      dutyCycleSlide = -ps.dutySweep * 0.00005;

      if (ps.arpMod >= 0)
        arpeggioMultiplier = 1 - pow(ps.arpMod, 2) * 0.9;
      else
        arpeggioMultiplier = 1 + pow(ps.arpMod, 2) * 10;
      arpeggioTime = floor(pow(1 - ps.arpSpeed, 2) * 20000 + 32);
      if (ps.arpSpeed === 1)
        arpeggioTime = 0;
    }

    initForRepeat();

    // Waveform shape
    var waveShape = parseInt(ps.shape);

    // Filter
    var fltw = pow(ps.lpf, 3) * 0.1;
    var enableLowPassFilter = (ps.lpf != 1);
    var fltw_d = 1 + ps.lpfSweep * 0.0001;
    var fltdmp = 5 / (1 + pow(ps.lpfResonance, 2) * 20) * (0.01 + fltw);
    if (fltdmp > 0.8)
      fltdmp=0.8;
    var flthp = pow(ps.hpf, 2) * 0.1;
    var flthp_d = 1 + ps.hpfSweep * 0.0003;

    // Vibrato
    var vibratoSpeed = pow(ps.vibSpeed, 2) * 0.01;
    var vibratoAmplitude = ps.vibDepth * 0.5;

    // Envelope
    var envelopeLength = [
      floor(ps.attack * ps.attack * 100000),
      floor(ps.sustain * ps.sustain * 100000),
      floor(ps.decay * ps.decay * 100000)
    ];
    var envelopePunch = ps.punch;

    // Flanger
    var flangerOffset = pow(ps.flangerOffset, 2) * 1020;
    if (ps.flangerOffset < 0)
      flangerOffset = -flangerOffset;
    var flangerOffsetSlide = pow(ps.flangerSweep, 2) * 1;
    if (ps.flangerSweep < 0)
      flangerOffsetSlide = -flangerOffsetSlide;

    // Repeat
    var repeatTime = floor(pow(1 - ps.repeatSpeed, 2) * 20000 + 32);
    if (ps.repeatSpeed === 0)
      repeatTime = 0;

    var gain = pow(2, ps.vol) - 1;

    var fltp = 0;
    var fltdp = 0;
    var fltphp = 0;

    // TODO: Deterministic output! Don't randomize noise buffer here
    var noise_buffer = [];
    for (i = 0; i < 32; ++i)
      noise_buffer[i] = random() * 2 - 1;

    var envelopeStage = 0;
    var envelopeElapsed = 0;

    var vibratoPhase = 0;

    var phase = 0;
    var ipp = 0;
    var flanger_buffer = [];
    for (i = 0; i < 1024; ++i)
      flanger_buffer[i] = 0;

    var num_clipped = 0;

    var buffer = [];

    for(var t = 0; ; ++t) {

      // Repeats
      if (repeatTime !== 0 && ++elapsedSinceRepeat >= repeatTime)
        initForRepeat();

      // Arpeggio (single)
      if(arpeggioTime !== 0 && t >= arpeggioTime) {
        arpeggioTime = 0;
        period *= arpeggioMultiplier;
      }

      // Frequency slide, and frequency slide slide!
      periodMult += periodMultSlide;
      period *= periodMult;
      if(period > periodMax) {
        period = periodMax;
        if (enableFrequencyCutoff)
          break;
      }

      // Vibrato
      var rfperiod = period;
      if (vibratoAmplitude > 0) {
        vibratoPhase += vibratoSpeed;
        rfperiod = period * (1 + m.sin(vibratoPhase) * vibratoAmplitude);
      }
      var iperiod = floor(rfperiod);
      if (iperiod < OVERSAMPLING)
        iperiod = OVERSAMPLING;

      // Square wave duty cycle
      dutyCycle += dutyCycleSlide;
      if (dutyCycle < 0)
        dutyCycle = 0;
      if (dutyCycle > 0.5)
        dutyCycle = 0.5;

      // Volume envelope
      if (++envelopeElapsed > envelopeLength[envelopeStage]) {
        envelopeElapsed = 0;
        if (++envelopeStage > 2)
          break;
      }
      var env_vol;
      var envf = envelopeElapsed / envelopeLength[envelopeStage];
      if (envelopeStage === 0) {         // Attack
        env_vol = envf;
      } else if (envelopeStage === 1) {  // Sustain
        env_vol = 1 + (1 - envf) * 2 * envelopePunch;
      } else {                           // Decay
        env_vol = 1 - envf;
      }

      // Flanger step
      flangerOffset += flangerOffsetSlide;
      var iphase = abs(floor(flangerOffset));
      if (iphase > 1023)
        iphase = 1023;

      if (flthp_d !== 0) {
        flthp *= flthp_d;
        if (flthp < 0.00001)
          flthp = 0.00001;
        if (flthp > 0.1)
          flthp = 0.1;
      }

      // 8x oversampling
      var sample = 0;
      for (var si = 0; si < OVERSAMPLING; ++si) {
        var sub_sample = 0;
        phase++;
        if (phase >= iperiod) {
          phase %= iperiod;
          if (waveShape === NOISE)
            for(var i = 0; i < 32; ++i)
              noise_buffer[i] = random() * 2 - 1;
        }

        // Base waveform
        var fp = phase / iperiod;
        if (waveShape === SQUARE) {
          if (fp < dutyCycle)
            sub_sample=0.5;
          else
            sub_sample=-0.5;
        } else if (waveShape === SAWTOOTH) {
          if (fp < dutyCycle)
            sub_sample = -1 + 2 * fp/dutyCycle;
          else
            sub_sample = 1 - 2 * (fp-dutyCycle)/(1-dutyCycle);
        } else if (waveShape === SINE) {
          sub_sample = m.sin(fp * 2 * m.PI);
        } else if (waveShape === NOISE) {
          sub_sample = noise_buffer[floor(phase * 32 / iperiod)];
        } else {
          throw "ERROR: Bad wave type: " + waveShape;
        }

        // Low-pass filter
        var pp = fltp;
        fltw *= fltw_d;
        if (fltw < 0)
          fltw = 0;
        if (fltw > 0.1)
          fltw = 0.1;
        if (enableLowPassFilter) {
          fltdp += (sub_sample - fltp) * fltw;
          fltdp -= fltdp * fltdmp;
        } else {
          fltp = sub_sample;
          fltdp = 0;
        }
        fltp += fltdp;

        // High-pass filter
        fltphp += fltp - pp;
        fltphp -= fltphp * flthp;
        sub_sample = fltphp;

        // Flanger
        flanger_buffer[ipp & 1023] = sub_sample;
        sub_sample += flanger_buffer[(ipp - iphase + 1024) & 1023];
        ipp = (ipp + 1) & 1023;

        // final accumulation and envelope application
        sample += sub_sample * env_vol;
      }

      sample = sample / OVERSAMPLING;
      sample *= gain;

      buffer.push(sample);
    }

    // Create buffer
    var audioBuffer = audioContext.createBuffer(1, buffer.length || 1, sampleRate);
    audioBuffer.getChannelData(0).set(new Float32Array(buffer));

    return audioBuffer;
  };

  var Serializer = FXZ.Serializer = require("./serializer");
  FXZ.Params = Params;

  return FXZ;
})();
