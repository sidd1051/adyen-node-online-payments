const express = require("express");
const path = require("path");
const hbs = require("express-handlebars");
const dotenv = require("dotenv");
const morgan = require("morgan");
const { uuid } = require("uuidv4");

const { hmacValidator } = require('@adyen/api-library');
const { Client, Config, CheckoutAPI } = require("@adyen/api-library");

// In-memory store for authorised payments
const authorisedPayments = new Map();

// init app
const app = express();
// setup request logging
app.use(morgan("dev"));
// Parse JSON bodies
app.use(express.json());
// Parse URL-encoded bodies
app.use(express.urlencoded({ extended: true }));
// Serve client from build folder
app.use(express.static(path.join(__dirname, "/public")));

// enables environment variables by
// parsing the .env file and assigning it to process.env
dotenv.config({
  path: "./.env",
});

// Adyen NodeJS library configuration
const config = new Config();
config.apiKey = process.env.ADYEN_API_KEY;
const client = new Client({ config });
client.setEnvironment("TEST");  // change to LIVE for production
const checkout = new CheckoutAPI(client);

app.engine(
  "handlebars",
  hbs.engine({
    defaultLayout: "main",
    layoutsDir: __dirname + "/views/layouts",
    helpers: require("./util/helpers"),
  })
);

app.set("view engine", "handlebars");

/* ################# API ENDPOINTS ###################### */

// Invoke /sessions endpoint
app.post("/api/sessions", async (req, res) => {

  try {
    // unique ref for the transaction
    const orderRef = uuid();
    // Allows for gitpod support
    const localhost = req.get('host');
    // const isHttps = req.connection.encrypted;
    const protocol = req.socket.encrypted? 'https' : 'http';
    // Ideally the data passed here should be computed based on business logic
    const amount = { currency: "EUR", value: 10000 }; // value is 100€ in minor units

    const response = await checkout.PaymentsApi.sessions({
      amount,
      countryCode: "NL",
      merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT, // required
      reference: orderRef, // required: your Payment Reference
      returnUrl: `${protocol}://${localhost}/handleShopperRedirect?orderRef=${orderRef}`, // set redirect URL required for some payment methods (ie iDEAL)
      // delay capture to allow auth & capture flow
      additionalData: { authorisationType: "PreAuth" },
      // set lineItems required for some payment methods (ie Klarna)
      lineItems: [
        { quantity: 1, amountIncludingTax: 5000, description: "Sunglasses" },
        { quantity: 1, amountIncludingTax: 5000, description: "Headphones" }
      ]
    });

    // store the amount for later capture
    authorisedPayments.set(orderRef, { amount: amount.value, currency: amount.currency });

    res.json(response);
  } catch (err) {
    console.error(`Error: ${err.message}, error code: ${err.errorCode}`);
    res.status(err.statusCode).json(err.message);
  }
});

// Capture authorised payment within 7 days
app.post("/api/capture", async (req, res) => {
  const { orderRef } = req.body;

  if (!authorisedPayments.has(orderRef)) {
    console.error(`Capture failed: unknown orderRef ${orderRef}`);
    return res.status(404).json({ message: "Payment not found" });
  }

  const payment = authorisedPayments.get(orderRef);

  if (!payment.pspReference) {
    console.error(`Capture failed: payment ${orderRef} not authorised yet`);
    return res.status(400).json({ message: "Payment not authorised" });
  }

  // check capture is within 7 days from authorisation
  const diffMs = Date.now() - payment.authorisedAt.getTime();
  if (diffMs > 7 * 24 * 60 * 60 * 1000) {
    console.error(`Capture failed: authorisation for ${orderRef} expired`);
    return res.status(400).json({ message: "Capture period expired" });
  }

  try {
    const response = await checkout.ModificationsApi.captureAuthorisedPayment(
      payment.pspReference,
      {
        merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT,
        amount: { currency: payment.currency, value: payment.amount },
        reference: orderRef,
      }
    );
    console.log(`Capture successful for ${orderRef}`);
    res.json(response);
  } catch (err) {
    console.error(`Capture API error for ${orderRef}: ${err.message}`);
    res.status(err.statusCode || 500).json({ message: err.message });
  }
});


/* ################# end API ENDPOINTS ###################### */

/* ################# CLIENT SIDE ENDPOINTS ###################### */

// Index (select a demo)
app.get("/", (req, res) => res.render("index"));

// Cart (continue to checkout)
app.get("/preview", (req, res) =>
  res.render("preview", {
    type: req.query.type,
  })
);

app.get("/checkout/dropin", (req, res) =>
  res.render("dropin", {
    clientKey: process.env.ADYEN_CLIENT_KEY
  })
);

app.get("/checkout/card", (req, res) =>
  res.render("card", {
    clientKey: process.env.ADYEN_CLIENT_KEY
  })
);

app.get("/checkout/googlepay", (req, res) =>
  res.render("googlepay", {
    clientKey: process.env.ADYEN_CLIENT_KEY
  })
);

app.get("/checkout/ideal", (req, res) =>
  res.render("ideal", {
    clientKey: process.env.ADYEN_CLIENT_KEY
  })
);

app.get("/checkout/klarna", (req, res) =>
  res.render("klarna", {
    clientKey: process.env.ADYEN_CLIENT_KEY
  })
);

app.get("/checkout/sepa", (req, res) =>
  res.render("sepa", {
    clientKey: process.env.ADYEN_CLIENT_KEY
  })
);


// Result page
app.get("/result/:type", (req, res) =>
  res.render("result", {
    type: req.params.type,
  })
);

// Handle redirect during payment. This gets called during the redirect flow
app.all("/handleShopperRedirect", async (req, res) => {
  // Create the payload for submitting payment details
  const redirect = req.method === "GET" ? req.query : req.body;
  const details = {};
  if (redirect.redirectResult) {
    details.redirectResult = redirect.redirectResult;
  } else if (redirect.payload) {
    details.payload = redirect.payload;
  }
  const orderRef = redirect.orderRef || req.query.orderRef;

  try {
    const response = await checkout.PaymentsApi.paymentsDetails({ details });
    if (response.pspReference && authorisedPayments.has(orderRef)) {
      const stored = authorisedPayments.get(orderRef);
      stored.pspReference = response.pspReference;
      stored.authorisedAt = new Date();
      authorisedPayments.set(orderRef, stored);
    }
    // Conditionally handle different result codes for the shopper
    switch (response.resultCode) {
      case "Authorised":
        res.redirect("/result/success");
        break;
      case "Pending":
      case "Received":
        res.redirect("/result/pending");
        break;
      case "Refused":
        res.redirect("/result/failed");
        break;
      default:
        res.redirect("/result/error");
        break;
    }
  } catch (err) {
    console.error(`Error: ${err.message}, error code: ${err.errorCode}`);
    res.redirect("/result/error");
  }
});

/* ################# end CLIENT SIDE ENDPOINTS ###################### */

/* ################# WEBHOOK ###################### */

// Process incoming Webhook: get NotificationRequestItem, validate HMAC signature,
// consume the event asynchronously, send response status code 202
app.post("/api/webhooks/notifications", async (req, res) => {

  // YOUR_HMAC_KEY from the Customer Area
  const hmacKey = process.env.ADYEN_HMAC_KEY;
  const validator = new hmacValidator()
  // Notification Request JSON
  const notificationRequest = req.body;
  const notificationRequestItems = notificationRequest.notificationItems

  // fetch first (and only) NotificationRequestItem
  const notification = notificationRequestItems[0].NotificationRequestItem
  console.log(notification)
  
  // Handle the notification
  if( validator.validateHMAC(notification, hmacKey) ) {
    // valid hmac: process event
    const merchantReference = notification.merchantReference;
    const eventCode = notification.eventCode;
    console.log("merchantReference:" + merchantReference + " eventCode:" + eventCode);

    // consume event asynchronously
    consumeEvent(notification);

    // acknowledge event has been consumed
    res.status(202).send(); // Send a 202 response with an empty body

  } else {
    // invalid hmac
    console.log("Invalid HMAC signature: " + notification);
    res.status(401).send('Invalid HMAC signature');
  }

});

// process payload asynchronously
function consumeEvent(notification) {
  // add item to DB, queue or different thread
  
}



/* ################# end WEBHOOK ###################### */

/* ################# UTILS ###################### */

function getPort() {
  return process.env.PORT || 8080;
}

/* ################# end UTILS ###################### */

// Start server
app.listen(getPort(), () => console.log(`Server started -> http://localhost:${getPort()}`));
