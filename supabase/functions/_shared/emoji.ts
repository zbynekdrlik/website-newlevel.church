const SMS_EMOJI_SHORTCODES: Record<string, string> = {
  smiling_face_with_tear: "🥲",
  round_pushpin: "📍",
  raised_hands: "🙌",
  pray: "🙏",
  folded_hands: "🙏",
  tada: "🎉",
  fire: "🔥",
  heart: "❤️",
  blue_heart: "💙",
  white_heart: "🤍",
  sparkles: "✨",
  musical_note: "🎵",
  notes: "🎶",
  pizza: "🍕",
  hamburger: "🍔",
  game_die: "🎲",
  soccer: "⚽",
  star: "⭐",
  warning: "⚠️",
  point_right: "👉",
  point_down: "👇",
  wave: "👋",
  smile: "😄",
  slightly_smiling_face: "🙂",
};

export function expandSmsEmojiShortcodes(value: string) {
  return value.replace(/:([a-z0-9_+-]+):/gi, (match, key: string) => {
    return SMS_EMOJI_SHORTCODES[key.toLowerCase()] ?? match;
  });
}
