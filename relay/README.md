# Use a public connection

Choose **srv.us** in **Setup → Connect the tunnel**. OneCode includes the SSH client and stores a dedicated device key in secure storage. The first **Connect** authorizes publication. **Connect when OneCode starts** restores a previously connected connector, and OneCode retries interrupted transport connections with the same URL. Paste the HTTPS connector address shown in Setup into the provider.

In **Settings → Remote**, choose **srv.us**, enable Remote, then **Copy pairing link** for each new browser. The Remote address uses a separate device key and hostname. Remote resumes on app launch while enabled, including ordinary restarts and updates. Turning Remote off withdraws the route and revokes browser sessions. The Mac, PC, or Linux host must stay awake with OneCode running. srv.us uses outbound SSH on port 22 and handles public TLS. [srv.us documentation](https://docs.srv.us/)

## Run your own relay

OneCode starts the chat and connector services on loopback. This relay provides the public HTTPS addresses for those services. A device makes outbound connections to the relay and reconnects after interruptions. Each device gets separate Remote and MCP hostnames.

### Deploy the relay

1. Choose a public HTTPS hostname for the relay on a server you operate. Point the hostname and its wildcard subdomain to that server. Obtain a trusted TLS certificate that covers both names. For example, a relay at `relay.example.net` needs certificate coverage for `relay.example.net` and `*.relay.example.net`.
2. Run `node relay/start.mjs enroll` privately on Node.js 24 or later for each installation. Put only the resulting device digests in a JSON array in the relay enrollment file. Give each device owner the relay URL and their own key over a private channel.
3. Set `ONECODE_RELAY_ORIGIN` to the HTTPS relay address, `ONECODE_RELAY_ENROLLMENTS` to the JSON file path, and `ONECODE_RELAY_TLS_KEY` and `ONECODE_RELAY_TLS_CERT` to the PEM file paths. Start `node relay/start.mjs` under a service manager. The default listener uses the HTTPS port from the origin or 443. Use `ONECODE_RELAY_LISTEN_HOST` and `ONECODE_RELAY_LISTEN_PORT` to override the bind address and port.
4. In **Settings → Remote → OneCode Relay enrollment**, enter the relay address and device key. Select **OneCode Relay (internet)** and enable Remote. Copy a pairing link for each new browser. For provider connectors, select **OneCode Relay** under **Setup → Advanced → Connection method**, connect, and use the new connector URL in the provider. Tailscale can be selected again in either place.

The relay uses TLS on both legs. It terminates HTTPS and can see traffic in transit, so use a relay operator you trust and keep access logs from recording request URLs, bodies, or headers. Chats and browser grants are stored on the OneCode host. A pairing link works once and expires in five minutes. **Revoke** removes the browser grant, and turning off Remote revokes all its browser grants.

Restart the relay after changing its certificate or enrollment file. To retire an installation key, remove its digest and restart. A new key gives the installation new hostnames. Update the provider URLs and pair Remote browsers again. OneCode reconnects with the same URLs after an ordinary relay restart.
