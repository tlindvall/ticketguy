'use client';
import { useState } from 'react';

/**
 * Copies the concierge address: the fallback for visitors whose email link opens nothing (no mail app, or a
 * webmail-only browser). A prompt with the address stands in when the clipboard is unavailable.
 */
export function CopyAddress({ address, className = 'compose-copy', label = 'Copy address' }: { address: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt('Copy the address:', address);
    }
  };
  return (
    <button type="button" className={className} onClick={copy} aria-live="polite">
      {copied ? 'Address copied' : label}
    </button>
  );
}
