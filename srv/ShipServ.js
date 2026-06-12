"use strict";

const cds = require("@sap/cds");
const LOG = cds.log('ss_service');
const express = require("express");
const multer = require("multer");
const FormData = require("form-data");
const { executeHttpRequest } = require("@sap-cloud-sdk/http-client");

const upload = multer({ storage: multer.memoryStorage() });

module.exports = cds.service.impl(function () {

  const app = cds.app;
  app.use(express.json({ limit: "10mb" }));

// ==============================
// INBOUND LOGIC
// ==============================

  this.on("Inbound", async (req) => {
    try {

      const { destination, path, method } = req.data;
      const headers = req.data.headers;
      const datajson = req.data.datajson;

      if (!destination)
        return { code: "400", message: "Missing required parameter: destination", data: { error: true } };

      if (!path)
        return { code: "400", message: "Missing required parameter: path", data: { error: true } };

      let headersArray = [];
      if (headers) {
        if (Array.isArray(headers)) headersArray = headers;
        else if (typeof headers === "object") headersArray = [headers];
      }

      const defaultHeaders = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Requested-With": "X"
      };

      const customHeaders = headersArray.reduce((acc, h) => {
        if (h && h.key && h.value) acc[h.key] = h.value;
        return acc;
      }, {});

      const finalHeaders = { ...defaultHeaders, ...customHeaders };

      let requestData = null;
      if (datajson) {
        if (Array.isArray(datajson)) {
          requestData = datajson.length === 1 ? datajson[0] : datajson;
        } else if (typeof datajson === "object") {
          requestData = datajson;
        }
      }

// ==============================
// BUYER EMAIL -> PURCHASING GROUP LOGIC
// ==============================

if (
  path.includes("API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder") &&
  requestData &&
  requestData.BuyerEmail
) {

  try {

    const buyerResponse = await executeHttpRequest(
      { destinationName: destination },
      {
        method: "POST",
        url: "/sap/opu/odata/sap/ZMM_SS_BUYER_SRV/BuyerSet",
        headers: finalHeaders,
        data: {
          BuyerCode: requestData.BuyerEmail
        }
      }
    );

    const buyerData = buyerResponse?.data?.d;

    if (buyerData?.BuyerCode) {

      // Replace Purchasing Group dynamically
      requestData.PurchasingGroup = buyerData.BuyerCode;

      LOG.info(
        `PurchasingGroup updated from Buyer API: ${buyerData.BuyerCode}`
      );
    }

    // Remove BuyerEmail before PO API call
    delete requestData.BuyerEmail;

  } catch (buyerError) {

    LOG.error("Buyer lookup failed", buyerError);

    // Optional:
    // delete BuyerEmail even if lookup fails
    delete requestData.BuyerEmail;

  }
}      

// ==============================
// PO TRANSFORMATION LOGIC 
// ==============================

if (
  path.includes("API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder") &&
  requestData &&
  requestData.to_PurchaseOrderItem
) {

  const discount = Number(requestData.DiscountPercentage || 0);
  const freight = Number(requestData.FreightCharges || 0);
  const items = requestData.to_PurchaseOrderItem;

  // --- Get only chargeable items
  const chargeableItems = items.filter(
    item => !item.PurchasingItemIsFreeOfCharge
  );

 // --- Freight split only for chargeable items
let freightValues = [];

if (freight && chargeableItems.length > 0) {

  const splitValue =
    Math.floor((freight / chargeableItems.length) * 100) / 100;

  let distributedTotal = 0;

  chargeableItems.forEach((item, index) => {

    let value;

    // Last item gets remaining balance
    if (index === chargeableItems.length - 1) {

      value = Number(
        (freight - distributedTotal).toFixed(2)
      );

    } else {

      value = splitValue;
      distributedTotal += value;

    }

    freightValues.push({
      itemRef: item,
      value: value
    });

  });
}

  // --- Process each item
  items.forEach((item) => {

    let pricing = [];

    // Keep only PBXX
    if (item.to_PurchaseOrderPricingElement) {
      pricing = item.to_PurchaseOrderPricingElement
        .filter(p => p.ConditionType === "PBXX")
        .map(p => ({
          ConditionType: p.ConditionType,
          ConditionRateValue: p.ConditionRateValue,
          ConditionCurrency: p.ConditionCurrency
        }));
    }

    // --- Apply Discount (only chargeable)
    if (discount && !item.PurchasingItemIsFreeOfCharge) {
      pricing.push({
        ConditionType: "RA01",
        ConditionRateValue: discount.toString(),
        ConditionCurrency: item.DocumentCurrency
      });
    }

    // --- Apply Freight (only chargeable)
    const freightObj = freightValues.find(f => f.itemRef === item);
    const freightValue = freightObj?.value;
    if (freightValue !== undefined) {
      pricing.push({
        ConditionType: "ZFB2",
        ConditionRateValue: freightValue.toFixed(2),
        ConditionCurrency: item.DocumentCurrency
      });
    }

    item.to_PurchaseOrderPricingElement = pricing;
  });

  // --- Remove custom fields before SAP call
  delete requestData.DiscountPercentage;
  delete requestData.FreightCharges;
}

      const response = await executeHttpRequest(
        { destinationName: destination },
        {
          method: method || "POST",
          url: path,
          headers: finalHeaders,
          data: requestData
        }
      );

      return {
        code: "200",
        message: "Request processed successfully",
        data: response?.data || null
      };

    } catch (error) {

      const responseBody = error?.response?.data || error?.response?.body || null;

      const statusCode = String(
        error?.response?.status || error.code || error.status || error.statusCode || 502
      );

      let errorMessage = error.message;
      let details = [];

      if (responseBody && typeof responseBody === "object") {

        const sapError = responseBody?.error?.error || responseBody?.error || responseBody;

        errorMessage =
          sapError?.message?.value ||
          sapError?.message ||
          errorMessage;

        if (sapError?.innererror?.errordetails) {
          details = sapError.innererror.errordetails.map(e => ({
            code: e.code,
            message: e.message,
            severity: e.severity,
            target: e.target
          }));
        }
      }

      return {
        code: statusCode,
        message: errorMessage,
        data: {
          error: true,
          message: errorMessage,
          details: details,
          raw: responseBody
        }
      };
    }
  });

// ==============================
// OUTBOUND LOGIC
// ==============================

  this.on("Outbound", async (req) => {
    try {

      const { destination, path, method } = req.data;
      const headers = req.data.headers;
      const datajson = req.data.datajson;

      if (!destination)
        return { code: "400", message: "Missing required parameter: destination", data: { error: true } };

      if (!path)
        return { code: "400", message: "Missing required parameter: path", data: { error: true } };

      let headersArray = [];
      if (headers) {
        if (Array.isArray(headers)) headersArray = headers;
        else if (typeof headers === "object") headersArray = [headers];
      }

      const defaultHeaders = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Api-Version": "v2.1"
      };

      const customHeaders = headersArray.reduce((acc, h) => {
        if (h && h.key && h.value) acc[h.key] = h.value;
        return acc;
      }, {});

      const finalHeaders = { ...defaultHeaders, ...customHeaders };

      let requestData = null;
      if (datajson) {
        if (Array.isArray(datajson)) {
          requestData = datajson.length === 1 ? datajson[0] : datajson;
        } else if (typeof datajson === "object") {
          requestData = datajson;
        }
      }

// ==============================
// PR LOCK / UNLOCK SPECIAL LOGIC
// ==============================

if (
  path &&
  path.startsWith("/sap/opu/odata/sap/ZMM_SS_PR_LOCK_SRV_03/PRLOCKSet") &&
  requestData &&
  requestData.PrId
) {

  try {

    const auth =
      "Basic " +
      Buffer.from("babu.p:M9@mark9").toString("base64");

    // Fetch CSRF Token
    const csrfResponse = await executeHttpRequest(
      {
        url: "https://devhec.kuokgroup.com.sg"
      },
      {
        method: "GET",
        url: "/igwj/odata/SAP/ZMM_SS_PR_LOCK_SRV_03/PRLOCKSet",
        headers: {
          Authorization: auth,
          "X-CSRF-Token": "Fetch",
          Accept: "application/json"
        }
      }
    );

    const csrfToken = csrfResponse?.headers?.["x-csrf-token"];
    const cookies = csrfResponse?.headers?.["set-cookie"];

    if (!csrfToken) {
      throw new Error("Failed to fetch CSRF token");
    }

    // Execute PUT to HEC

    const hecResponse = await executeHttpRequest(
      {
        url: "https://devhec.kuokgroup.com.sg"
      },
      {
        method: method || "PUT",
        url: `/igwj/odata/SAP/ZMM_SS_PR_LOCK_SRV_03/PRLOCKSet(PrId='${requestData.PrId}')`,
        headers: {
          Authorization: auth,
          "X-CSRF-Token": csrfToken,
          Cookie: Array.isArray(cookies)
            ? cookies.join("; ")
            : cookies,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        data: {
          PrId: requestData.PrId,
          Status: requestData.Status
        }
      }
    );

    return {
      code: "200",
      message: "Request processed successfully",
      data: hecResponse?.data || null
    };

  } catch (error) {

    const responseBody =
      error?.response?.data ||
      error?.response?.body ||
      null;

    return {
      code: String(
        error?.response?.status ||
        error?.statusCode ||
        500
      ),
      message: error.message,
      data: {
        error: true,
        raw: responseBody
      }
    };
  }
}

      const response = await executeHttpRequest(
        { destinationName: destination },
        {
          method: method || "POST",
          url: path,
          headers: finalHeaders,
          data: requestData
        }
      );

      return {
        code: "200",
        message: "Request processed successfully",
        data: response?.data || null
      };

    } catch (error) {

      const responseBody = error?.response?.data || error?.response?.body || null;

      const statusCode = String(
        error?.response?.status || error.code || error.status || error.statusCode || 502
      );

      let errorMessage = error.message;
      let details = [];

      if (responseBody && typeof responseBody === "object") {

        const sapError = responseBody?.error?.error || responseBody?.error || responseBody;

        errorMessage =
          sapError?.message?.value ||
          sapError?.message ||
          errorMessage;

        if (sapError?.innererror?.errordetails) {
          details = sapError.innererror.errordetails.map(e => ({
            code: e.code,
            message: e.message,
            severity: e.severity,
            target: e.target
          }));
        }
      }

      return {
        code: statusCode,
        message: errorMessage,
        data: {
          error: true,
          message: errorMessage,
          details: details,
          raw: responseBody
        }
      };
    }
  });


// ==============================
// ATTACHMENT UPLOAD - INBOUND
// ==============================

  app.post("/ShipServ/attachInbound", upload.array("file", 10), async (req, res) => {
    try {

      const { destination, attachPath, csrfFetchPath, slug } = req.body;
      const files = req.files;

      if (!destination || !attachPath || !slug || !files?.length) {
        return res.status(400).json({
          success: false,
          message: "destination, attachPath, slug, and at least one file are required"
        });
      }

      const csrfResponse = await executeHttpRequest(
        { destinationName: destination },
        {
          method: "GET",
          url: csrfFetchPath || attachPath,
          headers: {
            "X-CSRF-Token": "Fetch",
            "Accept": "application/json"
          }
        }
      );

      const csrfToken = csrfResponse.headers["x-csrf-token"];
      const cookies = csrfResponse.headers["set-cookie"];

      if (!csrfToken)
        return res.status(500).json({
          success: false,
          message: "Failed to retrieve CSRF token from destination"
        });

      const uploaded = [];
      const failed = [];

      for (const file of files) {
        try {

          await executeHttpRequest(
            { destinationName: destination },
            {
              method: "POST",
              url: attachPath,
              headers: {
                "X-CSRF-Token": csrfToken,
                "X-Requested-With": "X",
                "Slug": `${slug}/${file.originalname}`,
                "Content-Type": file.mimetype,
                "Cookie": Array.isArray(cookies) ? cookies.join("; ") : cookies
              },
              data: file.buffer
            }
          );

          uploaded.push({ file: file.originalname, status: "success" });

        } catch (err) {
          failed.push({ file: file.originalname, error: err.message });
        }
      }

      return res.status(failed.length ? 207 : 200).json({
        success: failed.length === 0,
        slug,
        uploaded,
        failed
      });

    } catch (error) {

      return res.status(500).json({
        success: false,
        message: "Attachment upload failed",
        error: error.message
      });

    }
  });


// ==============================
// ATTACHMENT UPLOAD - OUTBOUND
// ==============================

  app.post("/ShipServ/attachOutbound", upload.array("file", 10), async (req, res) => {
    try {

      const { destination, attachPath } = req.body;
      const files = req.files;

      //if (!destination || !attachPath || !files?.length) {
       // return res.status(400).json({
         // success: false,
         // message: "destination, attachPath, and at least one file are required"
       // });
      //}

      const results = [];

      for (const file of files) {
        try {

          const form = new FormData();
          form.append("file", file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype
          });

          const response = await executeHttpRequest(
            { destinationName: "S4_to_SHIPSERV_DEV" },
            {
              method: "POST",
              url: "/attachments",
             // headers: {
             //   ...form.getHeaders()
             // },
              data: form
            }
          );

          results.push({
            file: file.originalname,
            success: true,
            asset: response?.data?.asset || null,
            signature: response?.data?.signature || null
          });

        } catch (err) {
          results.push({
            file: file.originalname,
            success: false,
            error: err?.response?.data || { message: err.message }
          });
        }
      }

      return res.status(200).json(results.length === 1 ? results[0] : results);

    } catch (error) {

      return res.status(500).json({
        success: false,
        message: "Outbound attachment upload failed",
        error: error.message
      });

    }
  });

  // ==============================
// ATTACHMENT UPLOAD - OUTBOUND NEW
// ==============================

  const FormData = require("form-data");

app.post("/ShipServ/attachOutboundData", async (req, res) => {
  try {

    LOG.debug('PR Attachment Service started', { data: req.body });

    const filedata = req.body.data;

    const results = [];

    try {

      const form = new FormData();

      const fileBuffer = Buffer.from(filedata.contentb64, "hex");

  
      form.append("file", fileBuffer, {
        filename: filedata.filename,
        contentType: filedata.mimetype,
      });

      const response = await executeHttpRequest(
        { destinationName: "S4_to_SHIPSERV_DEV" },
        {
          method: "POST",
          url: "/attachments",

          headers: {
            ...form.getHeaders()
           //"Content-Type": "multipart/form-data; boundary=--------------------------123456789",
           //"Content-Disposition": "form-data", "name":"file", "filename":"invoice.pdf",
          },

          data: form
        }
      );

      results.push({
        file: filedata.filename, 
        success: true,
        asset: response?.data?.asset || null,
        signature: response?.data?.signature || null
      });

    } catch (err) {
      results.push({
        file: filedata.filename,
        success: false,
        error: err?.response?.data || { message: err.message }
      });
    }

    return res.status(200).json(results[0]);

  } catch (error) {

    return res.status(500).json({
      success: false,
      message: "Outbound attachment upload failed",
      error: error.message
    });

  }
});

});
