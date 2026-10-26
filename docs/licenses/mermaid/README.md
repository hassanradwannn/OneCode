# Offline Mermaid preview notices

The application embeds the unmodified JavaScript bundle from the MIT-licensed
`@mermaid-js/tiny` npm package, version 12.2.0, inside an isolated diagram preview.
Its package license is included by the normal production dependency inventory.
The JavaScript bundle's own bundled license comment is retained verbatim in
`BUNDLED-NOTICES.txt` and in the shipped runtime.

The named bundled components also retain their full upstream license texts here:

- DOMPurify 3.4.12: Apache-2.0 / MPL-2.0 dual license.
- lodash-es 4.18.1: MIT and its supplied additional notices.

These files were extracted from the corresponding registry.npmjs.org tarballs
after validating the published SHA-512 integrity:

```text
@mermaid-js/tiny@12.2.0
sha512-9bEE+R974NTh1YJlfc6ztgwhy6+9sE+wAFiFrqvSdtlJHdxGfLytQmHYHNpFKmj94+Z+uMicYrQeGXnTTjILAQ==
dompurify@3.4.12
sha512-zQvGet8Z2sWbQhCmfFz/T5QWH2oBmjnqK3qvOjaqaNLrLEF912WamU+ohnTp0TCep/MFVHpdJuCZEdFOdTnEFg==
lodash-es@4.18.1
sha512-J8xewKD/Gk22OZbhpOVSwcs60zhd95ESDwezOFuA3/099925PdHJ7OFHNTGtajL3AlZkykD32HykiMo+BIBI8A==
```

Sources: https://github.com/mermaid-js/mermaid,
https://github.com/cure53/DOMPurify and https://github.com/lodash/lodash.
