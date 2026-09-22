/**
 * Service identity constants that must not depend on runtime configuration.
 * The addresses derived from these are only env defaults, so an operator can override
 * CONCIERGE_INBOUND_ADDRESS, CONCIERGE_FROM_ADDRESS and MARKETING_FROM_ADDRESS without editing code.
 */
export const SERVICE_DOMAIN = 'ticketguy.now';
export const MARKETING_SUBDOMAIN = `news.${SERVICE_DOMAIN}`;
export const SERVICE_URL = `https://${SERVICE_DOMAIN}`;
/** Sent on every outbound fetch so site operators can identify and contact us. */
export const CRAWLER_USER_AGENT = `TicketGuy/0.1 (+${SERVICE_URL})`;
