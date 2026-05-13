export interface Profile {
  userId: string;
  name: string;
  timezone: string;
  location?: string;
  bio?: string;
  birthDate?: string;
  /** Languages the user speaks. Distinct from primaryLanguage — this is just
   *  "comfortable in", not "respond to me in". */
  languages?: string[];
  /** Preferred language for the agent's responses. When set, the agent uses
   *  this regardless of the language of the user's current message (except
   *  for verbatim quotes). Source of truth for the response-language rule
   *  in ll5-run/CLAUDE.md. Empty/undefined = fall back to the
   *  default-English-with-Hebrew-match heuristic in CLAUDE.md. */
  primaryLanguage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateProfileInput {
  name?: string;
  timezone?: string;
  location?: string;
  bio?: string;
  birthDate?: string;
  languages?: string[];
  primaryLanguage?: string;
}
