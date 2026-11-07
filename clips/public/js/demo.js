// Sample numbers so the Data page has something to show before you connect
// an account. Seeded, so it looks the same every time.

function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const TITLES = [
  "He didn't see that coming #clips",
  "The beat switch at 0:14 🔥",
  "Studio session, unreleased",
  "Best reaction of the night",
  "When the hook hits different",
  "Behind the scenes in Sicily",
  "This verse is insane #fyp",
  "Producer breaks down the sample",
  "Live crowd sang every word",
  "Late night freestyle",
  "Story behind the track",
  "Answering your questions",
  "One take. No edits.",
  "First time hearing it",
  "Rate this drop 1–10",
  "The moment everything changed",
  "Who should we sign next?",
  "Cooking up something new",
];

export function demoStats() {
  const r = rng(20251107);
  const now = Date.now();
  const day = 86400000;
  const posts = [];
  let i = 0;
  for (let d = 88; d >= 0; d -= 1 + Math.floor(r() * 3)) {
    const platform = r() > 0.42 ? "tiktok" : "instagram";
    const hour = [11, 13, 17, 18, 19, 20, 21][Math.floor(r() * 7)];
    const created = new Date(now - d * day);
    created.setHours(hour, Math.floor(r() * 60), 0, 0);
    // heavy tail: most clips do okay, a few pop off
    const base = platform === "tiktok" ? 6000 : 3200;
    const growth = 1 + (88 - d) / 70;
    const viral = r() > 0.88 ? 6 + r() * 14 : 1;
    const hourBoost = hour >= 18 && hour <= 20 ? 1.5 : 1;
    const views = Math.round(base * growth * viral * hourBoost * (0.4 + r() * 1.4));
    const likes = Math.round(views * (0.05 + r() * 0.07));
    posts.push({
      platform,
      id: `demo_${i}`,
      title: TITLES[i % TITLES.length],
      cover: "",
      url: "",
      createdAt: +created,
      views,
      likes,
      comments: Math.round(likes * (0.03 + r() * 0.05)),
      shares: Math.round(likes * (0.04 + r() * 0.08)),
    });
    i++;
  }
  const history = [];
  let tt = 41200;
  let ig = 19400;
  for (let d = 89; d >= 0; d--) {
    tt += Math.round(40 + r() * 140 + (r() > 0.93 ? 900 : 0));
    ig += Math.round(15 + r() * 70 + (r() > 0.95 ? 400 : 0));
    history.push({ day: new Date(now - d * day).toISOString().slice(0, 10), tiktok: { followers: tt }, instagram: { followers: ig } });
  }
  return {
    demo: true,
    generatedAt: now,
    accounts: [
      { platform: "tiktok", username: "scannata.records", name: "Scannata Records", followers: tt, posts: posts.filter((p) => p.platform === "tiktok").length },
      { platform: "instagram", username: "scannatarecords", name: "Scannata Records", followers: ig, posts: posts.filter((p) => p.platform === "instagram").length },
    ],
    posts,
    history,
    errors: {},
  };
}
