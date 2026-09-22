import Link from 'next/link';

export default function Privacy() {
  return (
    <main className="tg-container">
      <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <strong>Draft — requires owner/legal review before launch.</strong> This placeholder describes the intended data handling of the pilot. It is not final policy text.
      </div>
      <h1 className="text-3xl font-bold">Privacy (draft)</h1>
      <div className="mt-4 space-y-3 text-gray-800">
        <p><strong>What we collect.</strong> The emails you send us (text and supported screenshots), the requests we derive from them, and our replies.</p>
        <p><strong>How we use it.</strong> To answer your request, to remember what you asked for if you write again, and—only if you explicitly opt in—to send occasional ticket offers. Sending a request does not subscribe you to anything.</p>
        <p><strong>AI processing.</strong> Extraction and drafting use OpenAI&apos;s API with storage disabled on our side; the provider&apos;s own retention terms apply and will be described accurately here before launch. Comparison math, ranking and advice rules run in our own code.</p>
        <p><strong>Retention (proposed).</strong> Raw email and attachments 30 days; normalized closed conversations 180 days; consent and audit records 24 months; licensed ticket observations per the shortest applicable provider term.</p>
        <p><strong>Deletion.</strong> Email us to delete your data. We verify the request, stop any watches, suppress marketing, and delete or redact personal content. A minimal keyed suppression record may be retained so we honor your opt-out. Provider and backup copies expire per their schedules.</p>
        <p><strong>Contact.</strong> Business name, postal address and privacy contact are set before launch.</p>
      </div>
      <p className="mt-8 text-sm"><Link href="/">Back</Link></p>
    </main>
  );
}
