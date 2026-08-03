/**
 * Reserved (provably undeliverable) destinations — the severance between the test
 * path and the production delivery path (Brief 31).
 *
 * THE FAULT THIS FIXES. The acceptance suite runs against the live Worker and every
 * address it uses is `@example.com`. Those sends were being handed to SendGrid for
 * real, against the SAME finite free-tier quota the alert path depends on — so a
 * full suite run could, and repeatedly did, exhaust the quota a survivor's alert
 * needed. Testing the safety system disabled the safety system.
 *
 * THE RULE. A destination that is reserved by RFC 2606 / RFC 5737-style convention
 * cannot receive anything, from anyone, ever. So we do not spend a real provider
 * call on it. We record the dispatch honestly and skip the vendor.
 *
 * WHY THIS AND NOT A TEST-MODE FLAG. A flag ("this request is a test") is a switch
 * that, if it were ever set wrongly or reachable by a client, would silently swallow
 * a REAL alert — the worst failure this system has. This rule is not a switch. It is
 * a property of the address itself:
 *
 *   - `example.com`, `example.net`, `example.org` are held by IANA for documentation
 *     and are guaranteed never to be operated as real mail domains (RFC 2606 §3).
 *   - the `.test`, `.example`, `.invalid`, `.localhost` TLDs are permanently reserved
 *     and can never be registered (RFC 2606 §2).
 *   - `+1 555 0100`–`+1 555 0199` is the reserved fictional NANP range.
 *
 * No survivor's real contact can ever fall in these ranges, so there is no
 * configuration to get wrong and no way for this to suppress a real alert. It is
 * fail-safe by construction rather than by discipline.
 *
 * NOTE this does not weaken any test: what the acceptance suite verifies is that the
 * system DISPATCHED correctly (right channel, right recipient, right moment). Whether
 * a third-party vendor then physically delivered is the vendor's reliability, which
 * belongs in monitoring, not in a gate that can take the alert path down with it.
 */

/** RFC 2606 §2 — permanently reserved TLDs that can never be registered. */
const RESERVED_TLDS = ['test', 'example', 'invalid', 'localhost'];

/** RFC 2606 §3 — second-level domains held by IANA for documentation. */
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

/**
 * Is this email address reserved, i.e. provably incapable of receiving mail?
 * Case-insensitive; tolerant of surrounding whitespace and a display name.
 */
export function isReservedEmail(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at === -1) {
    return false;
  }
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/[>\s]+$/, '');
  if (!domain) {
    return false;
  }
  if (RESERVED_DOMAINS.includes(domain)) {
    return true;
  }
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  return RESERVED_TLDS.includes(tld);
}

/**
 * Is this phone number in the reserved fictional range (+1 555 0100–0199)? Digits
 * are compared after stripping formatting, so +1 (555) 010-0123 and +15550100123
 * are treated alike.
 */
export function isReservedPhone(number: string): boolean {
  const digits = number.replace(/\D/g, '');
  const nanp = digits.startsWith('1') ? digits.slice(1) : digits;
  if (nanp.length !== 10) {
    return false;
  }
  // NPA-555-01XX — the block reserved for fictional use.
  return nanp.slice(3, 6) === '555' && nanp.slice(6, 8) === '01';
}

/** Channel-agnostic check used at the provider boundary. */
export function isReservedDestination(channel: string, identifier: string): boolean {
  switch (channel) {
    case 'email':
      return isReservedEmail(identifier);
    case 'sms':
      return isReservedPhone(identifier);
    default:
      // LINE user ids and push tokens have no reserved space; never suppress them.
      return false;
  }
}

/** The status written to delivery_records for a suppressed send. Deliberately NOT
 *  'delivered' — nothing was delivered, and honest status is the whole point. */
export const SUPPRESSED_STATUS = 'suppressed';
export const SUPPRESSED_REASON = 'reserved_address_not_deliverable';


/**
 * Brief 35 Fix B §A — distinct from SUPPRESSED_REASON on purpose.
 *
 * `suppressed_test` means "this identity can reach no real person". `suppressed_environment`
 * means "this deployment can reach no provider at all". They are separate controls answering
 * separate questions, and a delivery row has to say which one fired — §E1/§E2 turn on being able
 * to tell a production canary from a staging send at a glance.
 */
export const SUPPRESSED_ENVIRONMENT_REASON = 'suppressed_environment';
