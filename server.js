require("dotenv").config();
const { createApp } = require("./src/app");

const PORT = process.env.PORT || 3000;

// Need at least one usable inference path: a Gemini key, OR sovereign mode + a FLock key.
const sovereign = process.env.SOVEREIGN_AI === "1" || process.env.SOVEREIGN_AI === "true";
const hasGemini = !!process.env.GEMINI_API_KEY;
const hasFlock = sovereign && !!process.env.FLOCK_API_KEY;
if (!hasGemini && !hasFlock) {
  console.error(
    "No inference configured. Set GEMINI_API_KEY (https://aistudio.google.com/apikey), " +
      "or SOVEREIGN_AI=1 + FLOCK_API_KEY for FLock sovereign mode."
  );
  process.exit(1);
}

const app = createApp();
app.listen(PORT, () => {
  console.log(`Kappa Arbitrage running on port ${PORT}`);
  console.log(`Kappy (intake) + Bara (analysis) live${sovereign ? " — sovereign (FLock) mode" : ""}.`);
});
