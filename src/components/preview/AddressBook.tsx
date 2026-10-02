/**
 * "Save your ticket guy": an old address-book entry that downloads a contact card (vCard) with the address, so
 * the guy lives in the visitor's contacts for whenever they need tickets. Built as a data link: no request,
 * nothing stored.
 */
export function vcardHref(address: string) {
  const card = ['BEGIN:VCARD', 'VERSION:3.0', 'N:Guy;Ticket;;;', 'FN:Ticket Guy', 'ORG:Ticket Guy', `EMAIL;TYPE=INTERNET:${address}`, 'URL:https://ticketguy.now', 'NOTE:Your ticket guy. Email a link, a screenshot or your plans for a second opinion before you buy.', 'END:VCARD'].join('\r\n');
  return `data:text/vcard;charset=utf-8,${encodeURIComponent(card)}`;
}

export function AddressBook({ address }: { address: string }) {
  const href = vcardHref(address);
  return (
    <div className="win abook">
      <div className="win-bar"><span className="abook-icon" aria-hidden="true" /> Address Book</div>
      <dl className="abook-entry">
        <div><dt>Name:</dt><dd>Ticket Guy</dd></div>
        <div><dt>Email:</dt><dd>{address}</dd></div>
        <div><dt>Notes:</dt><dd>Tickets. Any time.</dd></div>
      </dl>
      <a className="btn-lime abook-save" href={href} download="ticket-guy.vcf">Save your ticket guy <span aria-hidden="true">↓</span></a>
    </div>
  );
}
