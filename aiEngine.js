// rps-server/aiEngine.js
//
// Node.js port of the client's src/engine/AIEngine.ts (AdaptiveAI).
// Dependency-free — the tiny move helpers from GameEngine.ts are inlined
// here so this file can be dropped into the server with no imports.
//
// Behavior preserved from the client:
//   - opponentHistory (cap 50), moveFrequencies, recentResults (cap 5)
//   - predictByPattern()  → bigram match over last `depth` moves
//   - predictByFrequency() → most common move in last `depth` (min 3, ≥5 samples)
//   - makeMove() decision order:
//       random → defense-on-losing-streak → aggression-on-winning-streak
//       → pattern-by-aggression → frequency-by-memory → counter-last-move → random
//   - difficulty scaling via DIFFICULTY_BASE
//   - personality blending via combinedRandomChance/MemoryDepth/Aggression
//
// ADDED for the server:
//   - PERSONALITY_PRESETS: map a string tag ('adaptive' | 'counter' |
//     'frequency' | 'pattern' | 'random') to { difficulty, personality }.
//   - normalizePersonality(): accepts a string tag OR a numeric personality
//     object OR nothing, and returns { difficulty, personality }.
//   - createAdaptiveAI(name, personalityInput): factory used by server.js.

'use strict';

// ─── Inlined GameEngine helpers ───

const ALL_MOVES = ['rock', 'paper', 'scissors'];

const COUNTERS = {
  rock: 'paper',
  paper: 'scissors',
  scissors: 'rock',
};

function getCounterMove(move) {
  return COUNTERS[move] || 'rock';
}

function getRandomMove() {
  return ALL_MOVES[Math.floor(Math.random() * ALL_MOVES.length)];
}

// ─── Personality + difficulty tables ───

const DEFAULT_PERSONALITY = {
  aggression: 0.5,
  memory: 0.5,
  randomness: 0.5,
  defense: 0.5,
};

const DIFFICULTY_BASE = {
  easy:   { randomChance: 0.6,  memoryDepth: 0,  aggression: 0.1 },
  medium: { randomChance: 0.35, memoryDepth: 3,  aggression: 0.4 },
  hard:   { randomChance: 0.15, memoryDepth: 8,  aggression: 0.7 },
  expert: { randomChance: 0.05, memoryDepth: 30, aggression: 0.9 },
};

// String-tag presets. These are the labels the task refers to as
// "personalities: adaptive, counter, frequency, pattern, random".
const PERSONALITY_PRESETS = {
  adaptive: {
    difficulty: 'medium',
    personality: { aggression: 0.5, memory: 0.5, randomness: 0.5, defense: 0.5 },
  },
  counter: {
    difficulty: 'hard',
    personality: { aggression: 0.8, memory: 0.4, randomness: 0.2, defense: 0.6 },
  },
  frequency: {
    difficulty: 'hard',
    personality: { aggression: 0.5, memory: 0.9, randomness: 0.2, defense: 0.4 },
  },
  pattern: {
    difficulty: 'expert',
    personality: { aggression: 0.6, memory: 1.0, randomness: 0.1, defense: 0.4 },
  },
  random: {
    difficulty: 'easy',
    personality: { aggression: 0.1, memory: 0.1, randomness: 1.0, defense: 0.1 },
  },
};

function clamp01(n, fallback) {
  const v = typeof n === 'number' && isFinite(n) ? n : fallback;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function looksLikePersonalityObject(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return (
    typeof obj.aggression === 'number' ||
    typeof obj.memory === 'number' ||
    typeof obj.randomness === 'number' ||
    typeof obj.defense === 'number'
  );
}

// Accepts:
//   - undefined/null → adaptive preset
//   - string tag     → preset lookup (unknown tag → adaptive)
//   - object         → { difficulty: 'medium', personality: sanitized obj }
// Returns { difficulty, personality }
function normalizePersonality(input) {
  if (typeof input === 'string') {
    const tag = input.trim().toLowerCase();
    const preset = PERSONALITY_PRESETS[tag] || PERSONALITY_PRESETS.adaptive;
    return {
      difficulty: preset.difficulty,
      personality: { ...preset.personality },
    };
  }

  if (looksLikePersonalityObject(input)) {
    return {
      difficulty: 'medium',
      personality: {
        aggression: clamp01(input.aggression, DEFAULT_PERSONALITY.aggression),
        memory:     clamp01(input.memory,     DEFAULT_PERSONALITY.memory),
        randomness: clamp01(input.randomness, DEFAULT_PERSONALITY.randomness),
        defense:    clamp01(input.defense,    DEFAULT_PERSONALITY.defense),
      },
    };
  }

  // Fallback — adaptive
  const preset = PERSONALITY_PRESETS.adaptive;
  return {
    difficulty: preset.difficulty,
    personality: { ...preset.personality },
  };
}

// ─── AdaptiveAI ───

class AdaptiveAI {
  constructor(name = 'AI Opponent', difficulty = 'medium', personality) {
    this.name = name;
    this.difficulty = DIFFICULTY_BASE[difficulty] ? difficulty : 'medium';
    this.personality = personality
      ? {
          aggression: clamp01(personality.aggression, DEFAULT_PERSONALITY.aggression),
          memory:     clamp01(personality.memory,     DEFAULT_PERSONALITY.memory),
          randomness: clamp01(personality.randomness, DEFAULT_PERSONALITY.randomness),
          defense:    clamp01(personality.defense,    DEFAULT_PERSONALITY.defense),
        }
      : { ...DEFAULT_PERSONALITY };

    this.opponentHistory = [];
    this.moveFrequencies = { rock: 0, paper: 0, scissors: 0 };
    this.recentResults = [];
    this.stats = { wins: 0, losses: 0, ties: 0, totalGames: 0, winRate: 0 };
  }

  setPersonality(personality) {
    const { personality: p } = normalizePersonality(personality);
    this.personality = p;
  }

  recordOpponentMove(move) {
    if (!move) return;
    this.opponentHistory.push(move);
    if (this.moveFrequencies[move] === undefined) {
      this.moveFrequencies[move] = 0;
    }
    this.moveFrequencies[move]++;
    if (this.opponentHistory.length > 50) this.opponentHistory.shift();
  }

  recordResult(result) {
    this.stats.totalGames++;
    if (result === 'win') this.stats.wins++;
    else if (result === 'lose') this.stats.losses++;
    else this.stats.ties++;
    this.stats.winRate =
      this.stats.totalGames > 0 ? this.stats.wins / this.stats.totalGames : 0;

    this.recentResults.push(result);
    if (this.recentResults.length > 5) this.recentResults.shift();
  }

  getDifficultyBase() {
    return DIFFICULTY_BASE[this.difficulty] || DIFFICULTY_BASE.medium;
  }

  combinedRandomChance() {
    const base = this.getDifficultyBase().randomChance;
    const personality = this.personality.randomness;
    return Math.min(0.9, base * 0.6 + personality * 0.4);
  }

  combinedMemoryDepth() {
    const base = this.getDifficultyBase().memoryDepth;
    const personality = Math.floor(this.personality.memory * 30);
    return Math.max(2, Math.min(base + personality, 40));
  }

  combinedAggression() {
    const base = this.getDifficultyBase().aggression;
    const personality = this.personality.aggression;
    return Math.min(1, base * 0.6 + personality * 0.4);
  }

  isOnLosingStreak() {
    if (this.recentResults.length < 2) return false;
    return this.recentResults.slice(-2).every((r) => r === 'lose');
  }

  isOnWinningStreak() {
    if (this.recentResults.length < 2) return false;
    return this.recentResults.slice(-2).every((r) => r === 'win');
  }

  predictByPattern() {
    const depth = this.combinedMemoryDepth();
    if (depth < 2) return null;

    const history = this.opponentHistory.slice(-depth);
    if (history.length < 2) return null;

    const lastTwo = history.slice(-2);
    const matches = [];

    for (let i = 0; i < history.length - 2; i++) {
      if (history[i] === lastTwo[0] && history[i + 1] === lastTwo[1]) {
        matches.push(history[i + 2]);
      }
    }

    if (matches.length === 0) return null;

    const freq = { rock: 0, paper: 0, scissors: 0 };
    matches.forEach((m) => freq[m]++);

    let max = 0;
    let predicted = matches[0];
    for (const [m, c] of Object.entries(freq)) {
      if (c > max) {
        max = c;
        predicted = m;
      }
    }
    return predicted;
  }

  predictByFrequency() {
    const depth = this.combinedMemoryDepth();
    if (depth < 3) return null;

    const history = this.opponentHistory.slice(-depth);
    if (history.length < 5) return null;

    const freq = { rock: 0, paper: 0, scissors: 0 };
    history.forEach((m) => freq[m]++);

    let max = 0;
    let mostCommon = 'rock';
    for (const [m, c] of Object.entries(freq)) {
      if (c > max) {
        max = c;
        mostCommon = m;
      }
    }

    if (max < 3) return null;
    return mostCommon;
  }

  makeMove() {
    if (Math.random() < this.combinedRandomChance()) {
      return getRandomMove();
    }

    const aggression = this.combinedAggression();

    if (this.personality.defense > 0.6 && this.isOnLosingStreak()) {
      const lastMove = this.opponentHistory[this.opponentHistory.length - 1];
      if (lastMove) return getCounterMove(lastMove);
    }

    if (aggression > 0.7 && this.isOnWinningStreak()) {
      const lastMove = this.opponentHistory[this.opponentHistory.length - 1];
      if (lastMove) return getCounterMove(lastMove);
    }

    if (Math.random() < aggression) {
      const patternPrediction = this.predictByPattern();
      if (patternPrediction) return getCounterMove(patternPrediction);
    }

    const frequencyPrediction = this.predictByFrequency();
    if (frequencyPrediction && Math.random() < this.personality.memory) {
      return getCounterMove(frequencyPrediction);
    }

    const lastMove = this.opponentHistory[this.opponentHistory.length - 1];
    if (lastMove && Math.random() < aggression) {
      return getCounterMove(lastMove);
    }

    return getRandomMove();
  }

  getSummary() {
    const total = this.stats.totalGames;
    if (total === 0) return `${this.difficulty.toUpperCase()} AI · ${this.name}`;
    return `${this.difficulty.toUpperCase()} · ${this.stats.wins}W/${this.stats.losses}L/${this.stats.ties}T`;
  }

  reset() {
    this.opponentHistory = [];
    this.moveFrequencies = { rock: 0, paper: 0, scissors: 0 };
    this.recentResults = [];
    this.stats = { wins: 0, losses: 0, ties: 0, totalGames: 0, winRate: 0 };
  }
}

// ─── Factory ───

// personalityInput: string tag | numeric personality object | undefined
function createAdaptiveAI(name, personalityInput) {
  const { difficulty, personality } = normalizePersonality(personalityInput);
  return new AdaptiveAI(name, difficulty, personality);
}

module.exports = {
  AdaptiveAI,
  createAdaptiveAI,
  normalizePersonality,
  PERSONALITY_PRESETS,
  DEFAULT_PERSONALITY,
  // exported for tests / debugging
  getCounterMove,
  getRandomMove,
  ALL_MOVES,
};