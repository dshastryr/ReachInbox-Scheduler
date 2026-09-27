/** Cookie-session adapter; the HttpOnly session never enters browser storage. */
export const auth = {
  loginUrl(apiBase) { return `${apiBase}/api/auth/google`; },
};
