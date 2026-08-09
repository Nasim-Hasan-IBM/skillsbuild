// useDeck — React state + transport for a single deck.
//
// Owns the reducer-backed DeckState (the serializable transport + mixer controls) plus
// two pieces of live, high-rate state that must NOT live in the reducer (they update
// ~30x/sec and would otherwise trigger graph re-renders): the playhead position and
// the meter level. Both arrive asynchronously from the audio graph's analysis events.

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { getRuntime } from './audio';
import { loadTrackToVFS } from './track';
import {
  DeckState,
  initialDeckState,
  METER_EVENT_SUFFIX,
  POS_EVENT_SUFFIX,
} from './deck';

type EqBand = 'eqLow' | 'eqMid' | 'eqHigh';

type Action =
  | { type: 'LOAD'; track: DeckState['track'] }
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'SEEK'; norm: number }
  | { type: 'END' }
  | { type: 'SET_VOLUME'; value: number }
  | { type: 'SET_EQ'; band: EqBand; value: number }
  | { type: 'SET_FILTER'; value: number }
  | { type: 'SET_TEMPO'; value: number }
  // P4: loop
  | { type: 'SET_LOOP_IN'; norm: number }
  | { type: 'SET_LOOP_OUT'; norm: number }
  | { type: 'SET_LOOP_ACTIVE'; active: boolean }
  | { type: 'CLEAR_LOOP' }
  // P4: cue
  | { type: 'SET_CUE'; norm: number };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const clampTempo = (n: number) => Math.min(2.0, Math.max(0.5, n));

function reducer(s: DeckState, a: Action): DeckState {
  switch (a.type) {
    case 'LOAD':
      // New track: stop, rewind, and bump seekGen so the transport accumulator resets.
      // Also clear all P4 cue/loop state.
      return {
        ...s,
        track: a.track,
        playing: false,
        baseNorm: 0,
        seekGen: s.seekGen + 1,
        tempo: 1,
        loopIn: null,
        loopOut: null,
        loopActive: false,
        cuePoint: null,
      };
    case 'PLAY':
      return s.track ? { ...s, playing: true } : s;
    case 'PAUSE':
      return { ...s, playing: false };
    case 'SEEK':
      return s.track ? { ...s, baseNorm: clamp01(a.norm), seekGen: s.seekGen + 1 } : s;
    case 'END':
      // Reached the end: stop and rewind to the start.
      return { ...s, playing: false, baseNorm: 0, seekGen: s.seekGen + 1 };
    case 'SET_VOLUME':
      return { ...s, volume: clamp01(a.value) };
    case 'SET_EQ':
      return { ...s, [a.band]: a.value };
    case 'SET_FILTER':
      return { ...s, filterCutoff: Math.max(-1, Math.min(1, a.value)) };
    case 'SET_TEMPO':
      return { ...s, tempo: clampTempo(a.value) };
    // P4: loop
    case 'SET_LOOP_IN':
      return { ...s, loopIn: clamp01(a.norm) };
    case 'SET_LOOP_OUT':
      return { ...s, loopOut: clamp01(a.norm) };
    case 'SET_LOOP_ACTIVE':
      return { ...s, loopActive: a.active };
    case 'CLEAR_LOOP':
      return { ...s, loopIn: null, loopOut: null, loopActive: false };
    // P4: cue
    case 'SET_CUE':
      return { ...s, cuePoint: clamp01(a.norm) };
    default:
      return s;
  }
}

export interface UseDeck {
  state: DeckState;
  position: number; // live normalized playhead 0..1
  level: number; // live meter level 0..1
  load: (file: File) => Promise<void>;
  togglePlay: () => void;
  seek: (norm: number) => void;
  setVolume: (value: number) => void;
  setEq: (band: EqBand, value: number) => void;
  setFilter: (value: number) => void;
  setTempo: (value: number) => void;
  // P4: loop
  setLoopIn: () => void;
  setLoopOut: () => void;
  toggleLoop: () => void;
  clearLoop: () => void;
  // P4: cue
  setCuePoint: () => void;
  jumpToCue: () => void;
}

export function useDeck(id: string, audioReady: boolean): UseDeck {
  const [state, dispatch] = useReducer(reducer, id, initialDeckState);
  const [position, setPosition] = useState(0);
  const [level, setLevel] = useState(0);

  // Ref so the snapshot handler reads current `playing` without re-subscribing.
  const playingRef = useRef(state.playing);
  playingRef.current = state.playing;

  // Ref so cue/loop callbacks always see the latest position without re-creating.
  const positionRef = useRef(position);
  positionRef.current = position;

  // Ref so toggleLoop can read the current loopActive flag.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Route this deck's analysis events (playhead + meter) into local state.
  useEffect(() => {
    if (!audioReady) return;
    const rt = getRuntime();
    if (!rt) return;

    const posSource = `${id}${POS_EVENT_SUFFIX}`;
    const meterSource = `${id}${METER_EVENT_SUFFIX}`;

    const onSnapshot = (e: { source?: string; data: number }) => {
      if (e.source !== posSource) return;
      const p = clamp01(e.data);
      setPosition(p);
      if (p >= 0.9999 && playingRef.current) dispatch({ type: 'END' });
    };

    const onMeter = (e: { source?: string; min: number; max: number }) => {
      if (e.source !== meterSource) return;
      setLevel(clamp01(Math.max(Math.abs(e.min), Math.abs(e.max))));
    };

    rt.core.on('snapshot', onSnapshot);
    rt.core.on('meter', onMeter);
    return () => {
      rt.core.off('snapshot', onSnapshot);
      rt.core.off('meter', onMeter);
    };
  }, [id, audioReady]);

  const load = useCallback(
    async (file: File) => {
      const rt = getRuntime();
      if (!rt) return;
      const track = await loadTrackToVFS(rt, id, file);
      setPosition(0);
      dispatch({ type: 'LOAD', track });
    },
    [id],
  );

  const togglePlay = useCallback(() => {
    dispatch(playingRef.current ? { type: 'PAUSE' } : { type: 'PLAY' });
  }, []);

  const seek = useCallback((norm: number) => {
    setPosition(clamp01(norm));
    dispatch({ type: 'SEEK', norm });
  }, []);

  const setVolume = useCallback((value: number) => dispatch({ type: 'SET_VOLUME', value }), []);
  const setEq = useCallback((band: EqBand, value: number) => dispatch({ type: 'SET_EQ', band, value }), []);
  const setFilter = useCallback((value: number) => dispatch({ type: 'SET_FILTER', value }), []);
  const setTempo = useCallback((value: number) => dispatch({ type: 'SET_TEMPO', value }), []);

  // P4: loop
  const setLoopIn = useCallback(() => {
    dispatch({ type: 'SET_LOOP_IN', norm: positionRef.current });
  }, []);

  const setLoopOut = useCallback(() => {
    dispatch({ type: 'SET_LOOP_OUT', norm: positionRef.current });
  }, []);

  const toggleLoop = useCallback(() => {
    const s = stateRef.current;
    const turningOff = s.loopActive;
    dispatch({ type: 'SET_LOOP_ACTIVE', active: !s.loopActive });
    // On loop exit, rebase the transport so playback continues from the current
    // playhead position rather than running on from the accumulated loop phase.
    if (turningOff) {
      dispatch({ type: 'SEEK', norm: positionRef.current });
    }
  }, []);

  const clearLoop = useCallback(() => {
    dispatch({ type: 'CLEAR_LOOP' });
  }, []);

  // P4: cue
  const setCuePoint = useCallback(() => {
    dispatch({ type: 'SET_CUE', norm: positionRef.current });
  }, []);

  const jumpToCue = useCallback(() => {
    const { cuePoint } = stateRef.current;
    if (cuePoint !== null) {
      setPosition(cuePoint);
      dispatch({ type: 'SEEK', norm: cuePoint });
    }
  }, []);

  return {
    state,
    position,
    level,
    load,
    togglePlay,
    seek,
    setVolume,
    setEq,
    setFilter,
    setTempo,
    setLoopIn,
    setLoopOut,
    toggleLoop,
    clearLoop,
    setCuePoint,
    jumpToCue,
  };
}
