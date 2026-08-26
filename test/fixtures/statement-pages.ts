/**
 * Page text as `unpdf` actually extracts it from a Google Fi statement, with
 * names, address, phone number, and every amount replaced by synthetic ones.
 * Structure, line breaks, and ordering are verbatim — those are what the
 * parser depends on.
 *
 * The synthetic figures still balance the way a real statement does, because
 * the parser's checks depend on that:
 *   plan 138.00 + device 21.40           = 159.40 standard monthly
 *   taxes 26.40 + fees 7.15              =  33.55 taxes & regulatory
 *   159.40 - 12.75 credit + 33.55        = 180.20 total
 *   34.60 + 61.25 + 18.35 + 66.00        = 180.20 per-member
 */

export const PAGE_1 =
  "Statement\nAug 17, 2026\nSample Owner\n1 Example Street\nApt 4\nSan Francisco, CA 94115\n" +
  "United States\n(555) 555-0100\n24/7 Support\nVisit the help site -- we're here for\nyou anytime.\n" +
  "Access your account\nTo review your bill and payment\ninformation or to adjust your plan,\n" +
  "sign in here.\nPage 1 of 4\nThanks for being\na part of Google Fi Wireless\n" +
  "For Ada Byron, Grace Murray, Sample Owner, and Alan\nTuring\n" +
  "Here's your monthly statement for Aug 17, 2026\nTotal\n$180.20\n" +
  "$159.40 Standard monthly charges\n($12.75) Other charges & credits\n$33.55 Taxes & regulatory fees";

export const PAGE_2 =
  "Statement\nAug 17, 2026\nSample Owner\n1 Example Street\nApt 4\nSan Francisco, CA 94115\n" +
  "United States\n(555) 555-0100\nCredits, yay! Delayed charge\nPage 2 of 4\n" +
  "Standard monthly charges $159.40\nOther charges & credits ($12.75)\nTaxes & regulatory fees $33.55\n" +
  "Summary\nDescription Total (USD)\nUnlimited Standard plan $138.00\nDevice payment $21.40\n" +
  "Description Total (USD)\nService Credit ($12.75)\n" +
  "Includes sales and other taxes that Google is required by law to bill to its customers. " +
  "Also includes surcharges and expenses incurred by\nGoogle. Subject to change from time to time " +
  "without notice. Learn more at our help center.\nTotal $180.20\n" +
  "Ada Byron\n$34.60\nGrace Murray\n$61.25\nSample Owner\n$18.35\nAlan Turing\n$66.00\n" +
  "Total\n$180.20";

export const PAGE_3 =
  "Statement\nAug 17, 2026\nPage 3 of 4\nPrevious balance & payments $0.00\nTaxes $26.40\n" +
  "Fees & surcharges $7.15\nDetails (for Jul 17 - Aug 17)\nDescription Total (USD)\n" +
  "Previous balance as of Jul 17, 2026 $180.20\nPayment on Jul 28, 2026 ($180.20)";

export const PAGES = [PAGE_1, PAGE_2, PAGE_3];
