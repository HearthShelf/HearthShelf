import { Icon } from '@/components/common/Icon'

// Guidance shown when a server's public URL isn't a reachable HTTPS host. The
// hard requirement is a PUBLIC HTTPS HOSTNAME WITH A VALID CERT - app.hearthshelf.com
// connects the browser straight to this server's origin, so a bare IP or plain
// HTTP can't work (no CA cert for an IP; an HTTPS app can't bounce to http://).
// That is why opening a port (UPnP / port-forward) alone is NOT enough - this
// component says so explicitly. Rendered as a collapsible so it sits quietly in
// both the setup wizard and the Connect settings page.
export function ReachabilityHelp({ open = false }: { open?: boolean }) {
  return (
    <details className="cfg-card" open={open} style={{ marginTop: 'var(--s3)' }}>
      <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--s2)' }}>
        <Icon name="help" />
        <span className="sr-t">How do I make my server reachable?</span>
      </summary>

      <div className="sr-d" style={{ marginTop: 'var(--s3)' }}>
        app.hearthshelf.com opens your library by connecting your browser straight
        to your server, so your server needs a <strong>public web address that
        starts with https:// and has a valid certificate</strong> (for example
        <code> https://books.example.com</code>). A local address like
        <code> http://192.168.1.3:9277</code> won't work from the internet. Pick
        whichever path fits your setup:
      </div>

      <ol className="sr-d" style={{ marginTop: 'var(--s3)', paddingLeft: '1.2em', lineHeight: 1.7 }}>
        <li>
          <strong>Reverse proxy</strong> (nginx or Caddy) in front of HearthShelf,
          with a free Let's Encrypt certificate. You point a domain you own at your
          home, e.g. <code>https://books.example.com</code>. Caddy gets the
          certificate for you automatically.
        </li>
        <li>
          <strong>Cloudflare Tunnel</strong> - the easiest if you don't want to
          open ports or don't have a static IP. It gives you a public https address
          that reaches your server with no port forwarding.
        </li>
        <li>
          <strong>Dynamic DNS + certificate</strong> (e.g. DuckDNS) if your home IP
          changes. You get a free hostname like
          <code> https://yourname.duckdns.org</code> and a certificate for it.
        </li>
      </ol>

      <div className="sr-d" style={{ marginTop: 'var(--s3)' }}>
        After setup, set <strong>Public URL</strong> to that https address and
        re-check - it should turn green.
      </div>

      <div className="banner info" style={{ marginTop: 'var(--s3)' }}>
        <Icon name="info" />
        <span>
          <strong>Why not just open a port?</strong> Forwarding a port still leaves
          you on a bare IP address, and no certificate authority will issue a
          certificate for an IP - so the browser refuses the secure connection.
          That's why UPnP or port forwarding by itself isn't enough. A "no domain
          needed" option (hs.direct) is planned for the future.
        </span>
      </div>
    </details>
  )
}
