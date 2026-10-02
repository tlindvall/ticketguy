import Script from 'next/script';
import { env } from '@/lib/config/env';
import './cursors.css';

/**
 * Impact affiliate tracking (Universal Tracking Tag) on the public marketing pages only. Admin, preference
 * and unsubscribe pages sit outside this group on purpose: they show customer data or carry signed tokens in
 * the URL, and a third-party script must never see either. Live mode only, so fixture traffic is never counted.
 */
const IMPACT_UTT = `(function(i,m,p,a,c,t){c.ire_o=p;c[p]=c[p]||function(){(c[p].a=c[p].a||[]).push(arguments)};t=a.createElement(m);var z=a.getElementsByTagName(m)[0];t.async=1;t.src=i;z.parentNode.insertBefore(t,z)})('https://utt.impactcdn.com/P-A7873190-d3d7-493a-815a-bca2c449353d1.js','script','impactStat',document,window);impactStat('transformLinks');impactStat('trackImpression');`;

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      {env().APP_MODE === 'live' ? (
        <Script id="impact-utt" strategy="afterInteractive">
          {IMPACT_UTT}
        </Script>
      ) : null}
    </>
  );
}
