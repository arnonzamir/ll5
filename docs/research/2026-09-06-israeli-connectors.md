# Israeli connectors for LL5: banks, cards, utilities, HMO, municipal, notifications

Date: 2026-09-06. Scope: what an individual (not a licensed fintech) can pull programmatically from Israeli providers, and by which route. Sources are primary where reachable (regulator PDFs, developer portals, GitHub repos/issues/releases, provider help pages). Several provider pages sit behind Cloudflare/Radware/F5 bot walls and could not be fetched from this machine; those are marked "(bot-walled; content from search snippet)".

Convention note: `docs/` had no research-notes folder (only `reviews/`, `decisions/`, `runbooks/`, `implementation/`), so `docs/research/` is new.

## Summary table

| Source | What it exposes | Auth | Individual can use? | Maintenance signal | Route |
|---|---|---|---|---|---|
| Open Banking Israel (BOI Directive 368, Berlin Group NextGenPSD2) | Accounts, balances, transactions, cards, single/future/recurring payment initiation | OAuth-style consent at the bank + SCA; TPP must hold an ISA licence (or regulator approval) | No. Production is licensed-TPP only; sandboxes need company registration | Live since 04/2021 (info) and 03/2022 (payments); circular 2024-06-27 extends to corporates | API (via a licensed aggregator only) |
| israeli-bank-scrapers (eshaham) | Transactions/balances for 18 institutions | Web credentials; OTP callback for OneZero (and Cal/Hapoalim in open PRs) | Yes | v6.10.0 released 2026-09-06, 1,102 stars, 16 open issues, breakage monthly | Scraper |
| moneyman (daniel-hauser) | Scheduled scrape to Sheets/YNAB/Actual/Postgres/Telegram/web-POST/JSON | Same as above; OneZero OTP via Telegram bot | Yes | v2026.08.19.1, pushed 2026-09-03 | Scraper wrapper |
| Caspion (brafdlog) | Desktop (Electron) scrape to Sheets/YNAB/CSV/JSON | Same | Yes | v2.19.6 (2026-07-23), pushed 2026-09-05 | Scraper wrapper (desktop) |
| Financy / open-finance.ai | Licensed open-banking aggregator with a read-only REST API, CLI and MCP server | OAuth client credentials from the Financy app; paid plan | Yes (paid) | GitHub pushed 2026-09-03; 6 stars | API (aggregator) |
| RiseUp, Finanda, Moneytor | Licensed aggregators; Finanda sells an Excel export | App login | Yes as an app; no public API found | n/a | None programmatic |
| IEC (iec-custom-component) | Smart-meter readings, invoices, forecast, tariff, remaining-to-pay | ID number + OTP (SMS or email) via Okta; JWT with offline_access | Yes | 0.1.7 on 2026-09-06, 186 stars, 18 open issues, HACS custom repo | HA |
| Water (city-mind / Read Your Meter Pro) | Per-meter last reading, daily/monthly consumption, leak alerts | Email + password to RYM Pro v2 | Yes if the corporation enables RYM Pro (Arad meters) | pushed 2026-07-14, 54 stars, HACS | HA |
| Water (city4u_water_meter) | Water consumption from city4u for 77 verified municipalities | ID + permanent password | Yes | pushed 2026-02-26, 1 star | HA |
| Supergas Power (ha-supergas-power) | Latest gas invoice amount + status | 9-digit customer code + phone | Yes | pushed 2026-06-30, 0 stars | HA |
| PazGas Power (GuyKh) | "Info from PazGas Power API" (electricity retail) | UI config; details undocumented | Yes | pushed 2026-09-04, 0 stars | HA |
| Bezeq Energy (GuyKh) | Non-functional: password login removed by Bezeq | n/a | Not now | README carries a "non-functional" notice | HA (dead) |
| Bank of Israel exchange rates | Representative rates, XML/SDMX | None | Yes | Public API; HA integration pushed 2026-06-16 | API / HA |
| Israel Post tracking | Item trace | Public page now loads hCaptcha; 2016 JSON endpoint stale | Fragile | No maintained HA integration found | Scraper (fragile) / AfterShip |
| Telecom (Bezeq/Partner/Cellcom/HOT) | Nothing found | - | - | No HA integrations found | None |
| Clalit Online | Appointments, results, referrals, Form 17, pharmacy | ID + user code + password, or ID + captcha + SMS OTP | Scraping only | Scrapers exist (Playwright/Scrapy), no API | Scraper |
| Maccabi Online | Appointment search | ID + password (per 2022 scraper) | Scraping only | Last push 2022 | Scraper |
| city4u (ONE City, ex-"Automation") | Resident file: bills, payments, water readings | ID + password, SMS/voice OTP, or national ID login | Yes | Portal live; HA water integration exists | Scraper / HA |
| Card/bank push and SMS | Per-transaction SMS/push; Max mandates SMS above 500/1,000 NIS; Cal push for every transaction | Configured in each app | Yes | zenmoney/sms-formats has Hebrew regexes (pushed 2026-09-05) | Notification capture |

## 1. Bank and credit-card access

### 1a. Open Banking Israel (regulatory route)

- Legal basis: Proper Conduct of Banking Business Directive 368 ("יישום תקן של בנקאות פתוחה בישראל"), first published 02/2020. The BOI circular of 27 June 2024 (חט-1192) states that the original directive obliged banks and card companies to expose financial-information access (live 04/2021) and single-payment initiation (live 03/2022), and that access is granted to "a supervised financial entity that received its regulator's approval to operate in open banking". The same circular aligns 368 with the Payment Initiation Law (06/2023) and the Financial Information Service Law 5782-2021, adds future/recurring/bulk payment orders, and says the standard is based on the Berlin Group standard. Source: https://www.boi.org.il/media/wpupcreo/111528.pdf (text extracted locally with pdftotext).
- Bank Hapoalim's developer FAQ repeats the eligibility rule: "APIs included in the Open Banking Regulation are only available to companies supervised by the regulator (BOI)"; non-regulated APIs need only portal registration; standard is "Directive 368 and the NextGenPSD2 XS2A Framework ... Berlin Group"; consent requires the customer to pick data types and a consent period. https://poalimdev.co.il/faq
- Licensing: the ISA licenses "נותני שירות מידע פיננסי" under the 2021 law; the ISA directive to licence applicants/holders is at https://www.new.isa.gov.il/images/Fittings/isa/asset_library_pic/al_lobby/al_lobby-6267b530a26dd/horaha15322.pdf. There is no individual/personal-use licence class; the framework is company-only.
- Scale (ISA report "פעילות חברות נותנות שירותי מידע פיננסי", June-Nov 2024, extracted locally): 84,678 customers with consents, of which 68,489 individuals (99.9% of individual-type customers), 314.7M API calls in the period, 97.7% (307M) made by three central licensees. https://www.new.isa.gov.il/images/Fittings/isa/asset_library_pic/al_lobby/al_lobby-6267b530a26dd/isa_api_report.pdf
- Developer portals (BOI table, dated 01/09/2022): https://www.boi.org.il/media/31jb15vq/קישורים-לפורטל-המפתחים.pdf
  - Max: https://developers.max.co.il/max/openbanking (products "SCAOAuth 1.0.0" and "OpenBanking 1.0.0"; contact MaxOpenBankTeam@max.co.il)
  - Discount: http://www.openbanking.co.il/open-banking (returned 404 on 2026-09-06)
  - Beinleumi/Massad: https://devapi.test.fibi.co.il/fibi/sb (sandbox; JS-only page)
  - Hapoalim: https://poalimdev.co.il
  - Yahav: https://apiportal.yahav.co.il; Jerusalem: https://apiportal.bankjerusalem.co.il/
  - Leumi: http://www.leumiopenbanking.co.il (FinTeka; finteka.co.il did not resolve on 2026-09-06)
  - Mizrahi-Tefahot: https://devportal.sboapi.mizrahi-tefahot.co.il/mizrahi-tefahot-sandbox/sboapi/open_banking_lp (search snippet: sandbox migrated 2026-01-01)
  - Mercantile: https://www.mercantile.co.il/MB/openbanking
  - Isracard: https://openbanking.isracardgroup.co.il (Cloudflare-walled); marketing page says access is for holders of the regulator's dedicated certificate https://marketing.isracard.co.il/developer-portal/
  - Cal: https://www.cal-online.co.il/ecredit/financial-terms/dev-portal/ and a Layer7 portal at https://developer.cal-online.co.il/publish/apis
  - Pepper: https://www.pepperopenbanking.co.il; OneZero and Union: "portal not available at this stage" (2022 table).
- Scopes/consent/OTP: Berlin Group AIS consents (accounts, balances, transactions) with SCA at the ASPSP (redirect/OAuth). Consent duration is chosen by the customer at the bank (Hapoalim FAQ). Per-bank OTP specifics are not public outside the portals.
- Bottom line: no route for an individual to call bank APIs directly. The only API path is through a licensed aggregator.

### 1b. israeli-bank-scrapers and wrappers (practical route)

- Institutions and login fields (from `src/definitions.ts`): hapoalim (userCode, password), leumi (username, password), mizrahi, otsarHahayal, union, beinleumi, massad, pagi, max, visaCal (username, password), discount and mercantile (id, password, num), isracard and amex (id, card6Digits, password), yahav (username, nationalID, password), beyahadBishvilha and behatsdaa (id, password), oneZero (email, password, otpCodeRetriever, phoneNumber, otpLongTermToken). https://raw.githubusercontent.com/eshaham/israeli-bank-scrapers/master/src/definitions.ts
- 2FA design: README offers two paths, an async `otpCodeRetriever` callback or a long-term token (`getLongTermTwoFactorToken`, `triggerTwoFactorAuth`); only OneZero is wired today. https://raw.githubusercontent.com/eshaham/israeli-bank-scrapers/master/README.md
- OTP reality per institution (2026):
  - OneZero: OTP or `otpLongTermToken`; open issues #1144 (Cloudflare 403 with Node fetch/Undici, 2026-08-22) and #1158 (persistent token expires, saved-token login returns unactionable 401, 2026-08-20). https://github.com/eshaham/israeli-bank-scrapers/issues/1144 , https://github.com/eshaham/israeli-bank-scrapers/issues/1158
  - Hapoalim: SMS OTP on login from an unknown device with no way to enter it (issue #1077, 2026-03-21, closed stale; maintainer workaround: run once with `showBrowser: true`). PR #1084 (open since 2026-03-29) adds `otpCodeRetriever` plus `deviceTrustData` (about 50KB cookies+localStorage) to skip 2FA on later runs. https://github.com/eshaham/israeli-bank-scrapers/issues/1077 , https://github.com/eshaham/israeli-bank-scrapers/pull/1084
  - Visa Cal: password login returns only cards tied to that username; PR #1134 (open, 2026-07-02) adds an ID + last4 + SMS-OTP "quick login" that exposes PayBox/Diners/co-branded cards. https://github.com/eshaham/israeli-bank-scrapers/pull/1134
  - Isracard/Amex/Max/Leumi/Discount/Mizrahi/Beinleumi/Yahav: password-only in the library; no OTP hook.
- Runtime: Puppeteer ^24.40.0 with bundled Chromium; `israeli-bank-scrapers-core` uses puppeteer-core with your own `executablePath`; options `showBrowser`, `browser`, `browserContext`, `skipCloseBrowser`. package.json engines: node >= 22.22.2. https://github.com/eshaham/israeli-bank-scrapers
- Releases: v6.10.0 2026-09-06 (Isracard balances), v6.9.0 2026-07-22, v6.8.0 2026-07-08 (Cal frames), v6.7.10 2026-07-08 (Isracard bot-detection workaround), v6.7.9 2026-07-02 (Max login page), v6.7.8 2026-06-15 (Discount login URL), v6.7.7 2026-06-14 (Cal), v6.7.6 2026-06-12 (Yahav). https://github.com/eshaham/israeli-bank-scrapers/releases
- Breakage pattern (issues, 2026): Leumi moved to a Next.js "digitalfront" UI and business accounts broke (#1106, open 2026-09-06); Isracard password button not clicked (#1140, #1053, open); Hapoalim and Max failing since 2026-06-02 (#1120, open, stale); Beinleumi login broken (#1157, 2026-08-15); Mizrahi one-account failure aborts the run (#1156); Otsar HaHayal domain migration (#1069, closed 2026-09-02); OneZero Cloudflare TLS-fingerprint fix (#1126, closed 2026-06-15). Counts: 1,102 stars, 16 open issues, 17 open PRs. https://github.com/eshaham/israeli-bank-scrapers/issues
- moneyman: GitHub Actions cron `5 10,22 * * *` (12:05/00:05 Israel) or Docker; storage targets Google Sheets, Azure Data Explorer, YNAB, Actual Budget, Buxfer, PostgreSQL, Telegram, web POST, local JSON, OneDrive Excel (WIP); config via `MONEYMAN_CONFIG`/`MONEYMAN_CONFIG_PATH`; OneZero OTP is requested through the Telegram bot only when `notifications.telegram.enableOtp` is set and no `otpLongTermToken` is configured (`src/scraper/otp.ts`). Latest release v2026.08.19.1. https://github.com/daniel-hauser/moneyman
- Caspion: Electron desktop app over israeli-bank-scrapers, exports to Google Sheets, YNAB, CSV, JSON; "still in beta"; v2.19.6 on 2026-07-23; 266 stars. https://github.com/brafdlog/caspion
- Others: mottibec/israeli-bank-mcp (MCP server, credentials via `<BANK>_<FIELD>` env vars, separate 2FA tool; 34 stars, last push 2026-05-02) https://github.com/mottibec/israeli-bank-mcp ; sergienko4/israeli-bank-scrapers-to-actual-budget and tomerh2001/israeli-banks-actual-budget-importer (Actual Budget importers, found via code search for `otpLongTermToken`).

### 1c. Aggregators with an API

- Financy (open-finance.ai): Israeli licensed open-banking aggregator whose landing page advertises "Open Banking under Bank of Israel supervision, read-only", a bearer-token REST API (`api.open-finance.ai/data/transactions`), OAuth with scopes, and connection to Claude/GPT. The CLI/MCP (`npm i -g financy`) needs a paid plan (Starter/Pro/Ultra); credentials are clientId/clientSecret/userId from Settings > API; commands cover connections, accounts, balances, transactions, categories (English + Hebrew), providers/branches, refresh (20 credits). https://financy.open-finance.ai/ , https://github.com/open-finance-ai/financy (Apache-2.0, pushed 2026-09-03)
- RiseUp: holds an ISA licence and connects via open banking; no developer API found. https://www.riseup.co.il/בנקאות-פתוחה/ (bot-walled; content from search snippet)
- Finanda (MyFinanda) and Moneytor hold ISA licences; Finanda sells an Excel export; no API found. https://www.finanda.com/open-banking/ , https://moneytor.ai/
- FinCheck is an insurance/pension comparison service, not a transaction aggregator. https://www.fincheck.co.il/
- PayBox and Bit: no programmatic data access found. PayBox is reachable only as a card behind Cal quick-login (PR #1134).

## 2. Home Assistant integrations for Israeli providers

- IEC, GuyKh/iec-custom-component: login is ID number then OTP; config flow lets you choose SMS or email (`CONF_OTP_METHOD`, default "sms") and stores a JWT (`CONF_API_TOKEN`) with reauth on failure. py-iec-api authenticates against Okta (`iec-ext.okta.com`): `/api/v1/authn` lists factors, SMS is the factor whose email ends in `@sns.iec.co.il`, `/authn/factors/{id}/verify`, then `/oauth2/default/v1/token` with scope `openid email profile offline_access`. Sensors: forecasted usage/cost, today/yesterday/this-month consumption, latest meter reading, consumption and backstream since last invoice, last usage/cost/remaining-to-pay/days/bill date/last payment date, kWh tariff, token expiry. Polls hourly; IEC data can lag 2 days; dumb meters get only invoice sensors. HACS via custom repository (not default store). Releases: 0.1.7 2026-09-06, 0.1.6 2026-08-10, 0.1.5 2026-08-05, 0.1.4 2026-07-05 (recaptcha workaround on DeviceIn, reauth flow), 0.1.3 2026-04-27 (OTP method selector). 186 stars, 18 open issues. https://github.com/GuyKh/iec-custom-component , https://github.com/GuyKh/py-iec-api/blob/main/iec_api/login.py
- Water, maorcc/citymind_water_meter: Read Your Meter Pro v2 (Arad meters) with email + password; per-meter last reading, daily/monthly/forecast consumption, leak/consumption alert toggles, ILS/m3 cost config; legacy cp.city-mind.com ended 2022-12-31; HACS. 54 stars, pushed 2026-07-14. Mei Avivim's site points customers to Arad's Read Your Meter Pro, so Tel Aviv is covered if the account is enrolled. https://github.com/maorcc/citymind_water_meter , https://info.arad.co.il/
- Water via municipality, tsvi/city4u_water_meter: ID + permanent password (not SMS code) + meter number; hourly polling; historical import; 77 verified municipalities (list includes Mei Hod Hasharon, Mei Herzliya, Mei Carmel, Mei Modiin, Mei Ziona, Beer Sheva, Herzliya, Lod, Harish...). HACS custom. https://github.com/tsvi/city4u_water_meter/blob/main/SUPPORTED_MUNICIPALITIES.md
- Gas: Minitour/ha-supergas-power exposes the latest Supergas Power invoice amount with status/due-date/VAT attributes; auth is 9-digit customer code + phone; 12h default poll. https://github.com/Minitour/ha-supergas-power . GuyKh/pazgas-power-custom-component (electricity retail arm of Paz, not gas cylinders) exposes "info from PazGas Power API", UI-configured, wrapper GuyKh/py-pazgas-power. https://github.com/GuyKh/pazgas-power-custom-component . No Amisragas integration found.
- Electricity retailers: GuyKh/bezeq-energy-custom-component is marked non-functional ("username and password-based login is no longer supported"). https://github.com/GuyKh/bezeq-energy-custom-component
- Telecom (Bezeq, Partner, Cellcom, HOT): no Home Assistant integrations found on GitHub search.
- Israel Post: no maintained HA integration. The 2016 gist used `israelpost.co.il/itemtrace.nsf/trackandtraceJSON?openagent&lang=EN&itemcode=` https://gist.github.com/yisraeldov/c1587fc04fd99c944f644e3675f8c97c ; the current https://israelpost.co.il/itemtrace page loads hCaptcha (observed 2026-09-06), so scraping is fragile. AfterShip lists Israel Post as a carrier. https://www.aftership.com/he/carriers/israel-post
- Bank of Israel rates: public XML endpoint https://boi.org.il/PublicApi/GetExchangeRates?asXML=true and SDMX `https://edge.boi.org.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS` (BOI guide https://www.boi.org.il/media/tzxbuhhj/extracting-representative-exchange-rates-from-the-new-series-database.pdf). HA: Gugulator/boi_exchange_rates, no auth, 3h refresh, HACS custom. https://github.com/Gugulator/boi_exchange_rates
- Bank/card HA integrations: none found for Max, Isracard, Cal, Hapoalim or OneZero. Other Israeli HA repos seen: ziv-daniel/hass-israel-transportation-integration, GuyKh/air-sviva-custom-component, NirBY/ha-mashov, dawnburst/redalert-ha.

## 3. Clalit (and Maccabi)

- No public API. Clalit Online offers appointment booking, test results, requests to doctors/clinics, Form 17, sick-leave certificates, online pharmacy and referrals. Login: ID + user code + password, or "one-time code": ID (with check digit) + captcha, SMS code valid 5 minutes; the app adds biometrics. https://www.clalit.co.il/he/info/services/Pages/howto_zimun.aspx , https://www.clalit.co.il/he/info/services/Pages/otp.aspx
- Scrapers: dekelb/clalit-appt-checker (Scrapy; POSTs ASP.NET form to `e-services.clalit.co.il/OnlineWeb/General/Login.aspx` with ID+username+password, then `Zimunet/AvailableVisit/GetMonthlyAvailableVisit`; 22 stars, last push 2024-08-20) https://github.com/dekelb/clalit-appt-checker ; zoharargaman/clalit-appointments (Playwright, logs into e-services and drives the Tamuz iframe; pushed 2026-07-05) https://github.com/zoharargaman/clalit-appointments . None handle OTP; all rely on the permanent password.
- Maccabi: EyalMichaeli/SearchMaccabiDoc uses Maccabi Online ID + password to poll for earlier appointments; last push 2022-06-24. https://github.com/EyalMichaeli/SearchMaccabiDoc . No official API found.

## 4. Municipal portals

- city4u is run by ONE City (formerly "אוטומציה החדשה", owned by One Technologies; the operator is not Malam). The portal offers a "resident file" for payments and debts; login options on the portal are password, SMS one-time code, SMS/voice code, and national ID (הזדהות לאומית); the subscription is shared with the onecity payments site. https://www.city4u.co.il/PortalServicesSite/_portal/283000 , https://www.onecity.co.il/aboutus/
- No export/API. The only programmatic consumer found is tsvi/city4u_water_meter (section 2), which authenticates with ID + password and reads water consumption for 77 municipalities.
- "Muni-Pay / משלם / e-pay": no vendor by these names was found. Related routes: PayBox's MuniBox service delivers bimonthly arnona invoices into PayBox (search snippet), Israel Post offers arnona payment https://doar.israelpost.co.il/content/city-tax-payment/ , Tel Aviv runs its own tlvpay https://tlvpay.tel-aviv.gov.il/he/s/arnona , and Mast https://www.mast.co.il/35/services . None expose feeds.

## 5. Notification-based capture

- Max: free SMS updates; mandatory notification for every approved transaction above 500 or 1,000 NIS; SMS on execution and approval. https://www.max.co.il/cards/pages/sms (JS-rendered; content from search snippet)
- Cal: app push for all transaction types "including low-amount transactions", enabled in app settings after OTP or password login; CalSMS adds charge updates, 80%-of-limit reminder, internet transactions above a threshold, free. https://www.cal-online.co.il/service-and-support/push-notifications , https://www.cal-online.co.il/service-and-support/calsms (F5-walled; content from search snippet)
- Isracard: SMS/email alert service and monthly charge message. https://digital.isracard.co.il/products-services/sms/ (Cloudflare-walled)
- Documented Hebrew templates (zenmoney/sms-formats, regex + samples, pushed 2026-09-05):
  - Isracard/Amex (sent for Hapoalim-issued cards too): `שלום, בכרטיסך 7314 אושרה עסקה ב-19/04 בסך 29.75 ש"ח בנכסי הר חוטבים בע"מ. מידע נוסף ייקלט במערכות שלנו ויהיה ניתן לצפייה באתר בעוד 48 שעות https://4u.isracard.co.il/link/login. לשירותך, קבוצת ישראכרט` and the variant `בכרטיסך המסתיים ב- 6395, אושרה עסקה ...`; Amex ends with `https://4u.americanexpress.co.il/sms-transactionlist. לשירותך, אמריקן אקספרס`. https://github.com/zenmoney/sms-formats/tree/master/src/הפועלים-il_15700/formats
  - Max: `היי, ביקשת שנעדכן אותך על כל עסקת אינטרנט: היום 27/02 בית עסק ALIEXPRESS.COM חייב את כרטיסך 0995 בסך 72.91 $ ...` https://github.com/zenmoney/sms-formats/tree/master/src/max-il_15750/formats
  - Leumi Card/Max high-amount: `היי, ביקשת שנעדכן אותך על עסקאות בסכום גבוה: היום 01/08 בית עסק קשת טעמים ראשון לציון חייב את כרטיסך 2847 בסך 890.56 שח`; Leumi bank credit: `עדכון מלאומי: התקבל סכום של 11411 ש"ח מהעברת משכורת י (בחשבון המסתיים ב- 90758). מילת זיהוי: שלום` https://github.com/zenmoney/sms-formats/tree/master/src/לאומי-il_15701/formats
- No Cal SMS template was found in a public parser; a phishing sample quoted by Geektime shows the generic shape `בכרטיסך אושרה עסקה 25/08 בסך 1120 שח`. https://www.geektime.co.il/leumi-card-fishing-or-spam/

## Recommended routes for LL5

1. Cards and banks, near-real-time: notification capture on the Android companion (it already mirrors notifications). Enable Cal push for all transactions and Max/Isracard SMS; parse with the zenmoney regexes as a starting set. Reason: zero credentials stored server-side, no OTP, no scraper breakage; gives merchant/amount/last-4 within seconds.
2. Cards and banks, reconciliation and balances: run moneyman in Docker on the box on the existing 12:05/00:05 cadence, output to PostgreSQL or web POST into the gateway. Reason: it is the maintained wrapper over israeli-bank-scrapers with Telegram OTP plumbing, and the library still ships fixes weekly. Expect a monthly breakage; keep `showBrowser` one-off runs available for Hapoalim device trust until PR #1084 lands.
3. If a paid, credential-free option is acceptable: Financy's read-only API/MCP is the only licensed aggregator found that hands an individual an API key. Verify plan price and which institutions it lists before committing.
4. Do not pursue direct Open Banking APIs; production access is licensed-company only.
5. Utilities: IEC via iec-custom-component (or py-iec-api directly, since LL5 does not run HA): store the JWT with offline_access, poll hourly. Water via Read Your Meter Pro (if Mei Avivim account enrolled) or city4u_water_meter's endpoints. Gas: Supergas Power component if the supplier matches; otherwise treat gas as invoice-only.
6. Exchange rates: BOI public XML/SDMX, no auth.
7. Clalit: Playwright scraper with the permanent password (avoid the OTP path), scoped to appointments and results pages; treat as fragile and read-only.
8. Municipal: city4u login with ID + permanent password for the resident file; no feed exists, so poll rarely. Arnona invoices are better captured from PayBox/MuniBox or email.
9. Israel Post: prefer parsing SMS/email delivery notifications; the tracking page is captcha-protected.

## Unknowns

- Per-bank OTP behavior for Leumi, Discount, Mizrahi, Beinleumi and Yahav on new-device logins is not documented in the library; only Hapoalim (#1077) and Cal (#1134) have evidence.
- Whether Financy lists every institution and its exact plan prices; the pricing page was not fetched.
- Exact current Max/Cal/Isracard alert thresholds and the Cal SMS wording (pages are bot-walled; only search snippets were available).
- Israel Post's current tracking API behind hCaptcha.
- The current ISA licensee register page (only the 2024 statistics PDF and press coverage of names were found; Globes/law.co.il name Finanda, RiseUp, Green Invoice, Family Biz and four others, which is secondary sourcing).
- Whether Mei Avivim exposes its own portal data beyond Read Your Meter Pro.
- Discount's developer portal URL from the 2022 BOI table returns 404; the current URL is unknown.
