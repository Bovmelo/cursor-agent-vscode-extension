# Third-Party Notices

This project includes third-party software. The MIT license in this
repository applies to this project's original source code and does not
replace the licenses or terms of the components listed below.

## Cursor SDK

This extension uses `@cursor/sdk` 1.0.23 and its platform packages:

- `@cursor/sdk-darwin-arm64`
- `@cursor/sdk-darwin-x64`
- `@cursor/sdk-linux-arm64`
- `@cursor/sdk-linux-x64`
- `@cursor/sdk-win32-x64`

The upstream notice for the Cursor SDK is:

> © Anysphere Inc. All rights reserved. Use is subject to Cursor's
> [Terms of Service](https://cursor.com/terms-of-service).

The Cursor SDK and its platform binaries are not licensed under this
project's MIT license. This extension is an unofficial community project and
is not affiliated with or endorsed by Anysphere or Cursor.

The SDK's original license file is preserved in distributed VSIX packages at
`node_modules/@cursor/sdk/LICENSE.md`. License notices embedded in the SDK
bundles, including `*.LICENSE.txt` files, are also preserved.

## Direct runtime dependencies

| Component | Version | License |
| --- | --- | --- |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.12 | Apache-2.0 OR MPL-2.0 |
| [Marked](https://github.com/markedjs/marked) | 18.0.6 | MIT, with the bundled Markdown notice |

DOMPurify is distributed under the Apache License 2.0 option. Its Apache
License text and attribution are preserved at
`node_modules/dompurify/LICENSE` and in the distributed JavaScript.

Marked's complete upstream notice, including the Marked MIT license and the
Markdown copyright and redistribution terms, is preserved at
`node_modules/marked/LICENSE`.

## Cursor SDK runtime dependencies

The Cursor SDK brings additional runtime dependencies into packaged builds.
Their upstream license declarations are:

| Component | Version | License |
| --- | --- | --- |
| `@bufbuild/protobuf` | 1.10.0 | Apache-2.0 AND BSD-3-Clause |
| `@connectrpc/connect` | 1.7.0 | Apache-2.0 |
| `@connectrpc/connect-node` | 1.7.0 | Apache-2.0 |
| `@connectrpc/connect-web` | 1.7.0 | Apache-2.0 |
| `@statsig/client-core` | 3.31.0 | ISC |
| `@statsig/js-client` | 3.31.0 | ISC |
| `@types/trusted-types` | 2.0.7 | MIT |
| `undici` | 7.28.0 | MIT |
| `zod` | 3.25.76 | MIT |

Upstream license and notice files published with these packages are retained
in `node_modules` in distributed VSIX packages. The SDK's generated bundle
notices additionally retain attributions for bundled components such as
`ieee754`, `is-extendable`, `re2js`, `strip-bom-string`,
`formdata-polyfill`, `js-yaml`, and `ws`.

Dependency versions in this notice reflect `package-lock.json` for release
0.3.1. When dependencies change, this notice must be reviewed and updated
before distribution.
