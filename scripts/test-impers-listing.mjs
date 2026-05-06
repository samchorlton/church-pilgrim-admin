import * as impers from "impers";

function parseArgs(argv) {
  const parsed = {
    listing: "",
    impersonate: "safari",
    timeoutSeconds: 25,
    verify: true,
    caCert: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "");
    if (arg.startsWith("--listing=")) {
      parsed.listing = arg.slice("--listing=".length).trim();
      continue;
    }
    if ((arg === "--listing" || arg === "-l") && argv[i + 1]) {
      parsed.listing = String(argv[i + 1]).trim();
      i += 1;
      continue;
    }
    if (arg.startsWith("--impersonate=")) {
      parsed.impersonate = arg.slice("--impersonate=".length).trim() || parsed.impersonate;
      continue;
    }
    if (arg === "--impersonate" && argv[i + 1]) {
      parsed.impersonate = String(argv[i + 1]).trim() || parsed.impersonate;
      i += 1;
      continue;
    }
    if (arg.startsWith("--timeout=")) {
      const value = Number(arg.slice("--timeout=".length).trim());
      if (Number.isFinite(value) && value > 0) parsed.timeoutSeconds = value;
      continue;
    }
    if (arg === "--timeout" && argv[i + 1]) {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) parsed.timeoutSeconds = value;
      i += 1;
      continue;
    }
    if (arg === "--verify") {
      parsed.verify = true;
      continue;
    }
    if (arg === "--no-verify") {
      parsed.verify = false;
      continue;
    }
    if (arg.startsWith("--ca-cert=")) {
      parsed.caCert = arg.slice("--ca-cert=".length).trim();
      continue;
    }
    if (arg === "--ca-cert" && argv[i + 1]) {
      parsed.caCert = String(argv[i + 1]).trim();
      i += 1;
    }
  }

  return parsed;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node ./scripts/test-impers-listing.mjs --listing=<NHLE_LISTING_ID> [--impersonate=chrome] [--timeout=25] [--verify|--no-verify] [--ca-cert=.certs/cacert.pem]",
      "",
      "Examples:",
      "  node ./scripts/test-impers-listing.mjs --listing=1113644 --verify --ca-cert=.certs/cacert.pem",
      "  node ./scripts/test-impers-listing.mjs -l 1113644 --impersonate=chrome124 --timeout=30",
    ].join("\n")
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!/^\d+$/.test(options.listing)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const caCertPath =
    options.caCert ||
    process.env.SSL_CERT_FILE ||
    process.env.CURL_CA_BUNDLE ||
    "";
  const url = `https://historicengland.org.uk/listing/the-list/list-entry/${options.listing}`;

  try {
    const requestOptions = {
      impersonate: options.impersonate,
      timeout: options.timeoutSeconds,
      allowRedirects: true,
      verify: options.verify,
      ...(options.verify && caCertPath ? { caCert: caCertPath } : {}),
      headers: {
        "user-agent":
          "my-fetch/1.0",
      },
    };
    const response = await impers.get(url, {
      ...requestOptions,
    });

    const text = await response.aText();
    console.log(
      JSON.stringify(
        {
          listing: options.listing,
          status: response.status,
          ok: response.ok,
          finalUrl: response.url,
          bytes: text.length,
          impersonate: options.impersonate,
          verify: options.verify,
          caCert: options.verify ? (caCertPath || null) : null,
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error("IMPERS_TEST_ERROR", error?.name || "Error", error?.message || String(error));
    process.exitCode = 1;
  }
}

await main();
