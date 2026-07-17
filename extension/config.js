// TrueTabs - deployment constants. Empty string = the corresponding UI is
// hidden (no dead links). Filled in as the project ships:
//   TT_CWS_ID     - Chrome Web Store extension id (assigned on first publish)
//   TT_PAYPAL_URL - maintainer's PayPal.me link for the donate button
const TT_GITHUB_URL = "https://github.com/datysho/truetabs";
const TT_CWS_ID = "";
const TT_REVIEW_URL = TT_CWS_ID
  ? `https://chromewebstore.google.com/detail/${TT_CWS_ID}/reviews`
  : "";
const TT_PAYPAL_URL = "";
