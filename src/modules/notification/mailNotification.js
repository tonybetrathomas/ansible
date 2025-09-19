import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { randomBytes } from 'crypto';
import { getAsyncContextLogger } from '../../utils/logger.js';
import { getSsmParameter } from '../../utils/configLoader.js';

const region = process.env.AWS_REGION || "us-east-1";
const sesClient = new SESClient({ region });


function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}



function generateBoundary() {
  return `----=_Part_${Date.now()}_${randomBytes(16).toString('hex')}`;
}



function toBase64(str) {
  return Buffer.from(str).toString('base64');
}



function createRawEmail({ from, to, cc, subject, htmlBody, attachment }) {
  const boundary = generateBoundary();
  const mixedBoundary = generateBoundary();

  // Format recipients
  const toAddresses = Array.isArray(to) ? to.join(', ') : to;
  const ccAddresses = cc ? (Array.isArray(cc) ? cc.join(', ') : cc) : null;

  let rawEmail = '';

  // Email headers
  rawEmail += `From: ${from}\r\n`;
  rawEmail += `To: ${toAddresses}\r\n`;
  if (ccAddresses) {
    rawEmail += `Cc: ${ccAddresses}\r\n`;
  }
  rawEmail += `Subject: ${subject}\r\n`;
  rawEmail += 'MIME-Version: 1.0\r\n';
  rawEmail += `Content-Type: multipart/mixed; boundary="${mixedBoundary}"\r\n`;
  rawEmail += '\r\n';

  // Mixed part (HTML + attachment)
  rawEmail += `--${mixedBoundary}\r\n`;
  rawEmail += 'Content-Type: text/html; charset=utf-8\r\n';
  rawEmail += 'Content-Transfer-Encoding: quoted-printable\r\n';
  rawEmail += '\r\n';
  rawEmail += htmlBody;
  rawEmail += '\r\n\r\n';

  // Attachment part
  rawEmail += `--${mixedBoundary}\r\n`;
  rawEmail += `Content-Type: ${attachment.contentType}; name="${attachment.filename}"\r\n`;
  rawEmail += 'Content-Transfer-Encoding: base64\r\n';
  rawEmail += `Content-Disposition: attachment; filename="${attachment.filename}"\r\n`;
  rawEmail += '\r\n';

  // Content needs to be base64 encoded
  let base64Content = '';

  // If content is already base64 encoded
  if (attachment.encoding === 'base64') {
    base64Content = attachment.content;
  } else {
    base64Content = toBase64(attachment.content);
  }

  // Add line breaks to base64 content every 76 characters
  let i = 0;
  while (i < base64Content.length) {
    rawEmail += base64Content.substring(i, i + 76) + '\r\n';
    i += 76;
  }

  // End of message
  rawEmail += `--${mixedBoundary}--\r\n`;

  return rawEmail;
}

async function sendEmailWithAttachment(params) {
  const logger = getAsyncContextLogger();
  try {
    // Validate sender email
    if (!isValidEmail(params.from)) {
      throw new Error(`Invalid sender email address: "${params.from}"`);
    }

    // Validate recipient emails
    const recipients = Array.isArray(params.to) ? params.to : [params.to];
    for (const recipient of recipients) {
      if (!isValidEmail(recipient)) {
        throw new Error(`Invalid recipient email address: "${recipient}"`);
      }
    }

    // Validate CC emails if provided
    if (params.cc) {
      const ccRecipients = Array.isArray(params.cc) ? params.cc : [params.cc];
      for (const ccRecipient of ccRecipients) {
        if (!isValidEmail(ccRecipient)) {
          throw new Error(`Invalid CC email address: "${ccRecipient}"`);
        }
      }
    }

    // Create raw email message
    const rawEmail = createRawEmail(params);

    // Print first 500 characters of raw email for debugging
    logger.info(`Raw email headers: ${rawEmail.substring(0, 500)}...`);

    // Prepare destination addresses
    const toAddresses = Array.isArray(params.to) ? params.to : [params.to];
    const ccAddresses = params.cc
      ? (Array.isArray(params.cc) ? params.cc : [params.cc])
      : [];

    // Create SES command
    const command = new SendRawEmailCommand({
      Source: params.from,
      Destinations: [...toAddresses, ...ccAddresses],
      RawMessage: {
        Data: Buffer.from(rawEmail)
      }
    });

    // Send the email
    const response = await sesClient.send(command);
    logger.info(`Email sent successfully: ${JSON.stringify(response)}`);
    return response;
  } catch (error) {
    logger.error(`Error sending email: ${error.message}`, error.stack);
    throw error;
  }
}


export async function sentNotification(status, catalogData, catalog, customerName, tenantName) {
    const logger = getAsyncContextLogger();

  try {

    const parameterName = `/${customerName}/${tenantName}/framework/CD/NOTIFICATION/CONFIG`;

    const configData = await getSsmParameter(parameterName);

    //logger.info(`${JSON.stringify(configData)}`);

    const mailConfig = configData;//JSON.parse(configData);

    //logger.info(`corrspondence config data ${JSON.stringify(catalogData)}`)
    const deploymentRegion = catalogData[0].region;
    const product = catalogData[0].product;

    //const productMailConfig = mailConfig[catalogData[0].product][catalogData[0].region];

    logger.info(`Status at notification service : ${JSON.stringify(status)}`);

    const deployedUnit = catalog.replace('-catalog.yml', '');
    const SENDER_EMAIL = mailConfig.sender;//"USTHP.DevOpsSupport@usthealthproof.com";


    let RECIPIENT_EMAIL = mailConfig.default.to;

    if (mailConfig[product]?.to) {
      RECIPIENT_EMAIL = mailConfig[product].to;
      logger.info(`Correspondence at product level picked ${product} ${RECIPIENT_EMAIL}`);
    }

    if (mailConfig[product]?.[deploymentRegion]?.to) {
      RECIPIENT_EMAIL = mailConfig[product][deploymentRegion].to;

      logger.info(`Correspondence at product region level picked ${product} ${RECIPIENT_EMAIL}`);
    }
    

    let RECIPIENT_EMAIL_CC = mailConfig.default.cc;

    if (mailConfig[product]?.cc) {
      RECIPIENT_EMAIL_CC = mailConfig[product].cc;
     
    }
    
    if (mailConfig[product]?.[deploymentRegion]?.cc) {
      RECIPIENT_EMAIL_CC = mailConfig[product][deploymentRegion].cc;
    }

    const EMAIL_SUBJECT = `Deployment Status : ${deploymentRegion} - ${product} : ${deployedUnit}`;

    const head = `<head><title>${EMAIL_SUBJECT}</title>
        <style>t<style>table {border-collapse: collapse;width: 100%;}th, td {border: 1px solid black;padding: 8px;}</style></style></head>`;

    let fileContent = '';

    let rows = '';
    for (const msStatus of status) {
      const dbPackageCount = msStatus.db?.length ?? 1;
      rows = rows + `<tr><td rowspan="${dbPackageCount}">${msStatus.service}</td>
      <td  rowspan="${dbPackageCount}" >${msStatus.app.cluster ?? 'NA'}</td>
      <td  rowspan="${dbPackageCount}" >${msStatus.app.service ?? 'NA'}</td>
      <td  rowspan="${dbPackageCount}" >${msStatus.app.service ? msStatus.app.deploymentStatus.status : 'NA'}</td>
      <td>${msStatus.db?.length > 0 ? msStatus.db[0].file: 'NA'} </td>
      <td>${msStatus.db?.length > 0 ? msStatus.db[0].status + "("+msStatus.db[0].db+")" : 'NA'} </td></tr>`;
      fileContent = fileContent + `${msStatus.service} \n`;

      if (msStatus.app.deploymentStatus.status) {
        fileContent = fileContent + `${JSON.stringify(msStatus.app.deploymentStatus.status)}\n`;
      }
      if (msStatus.app.service && msStatus.app.deploymentStatus.status != 'NA') {
        
        if (msStatus.app.healthStatus) {
          fileContent = fileContent + `${JSON.stringify(msStatus.app.healthStatus)}\n\n`;
        }

        if (msStatus.app.deploymentStatus.updatedState 
          && msStatus.app.deploymentStatus.updatedState != "{}") {
          //  fileContent = fileContent + `${JSON.stringify(msStatus.app.deploymentStatus.updatedState)}\n\n`;
        }
      }
      

      for (let i = 0; i < dbPackageCount; i++) {
        fileContent = fileContent + `${msStatus.db[i].file}\n\n ${msStatus.db[i].status}\n\n ${msStatus.db[i].message}\n`;
        fileContent = fileContent + `-------------------------------------------------------\n\n\n`;
      }

      for (let j = 1; j < dbPackageCount; j++) {
        rows = rows + `<tr><td>${msStatus.db[j].file}</td><td>${msStatus.db[j].status} (${msStatus.db[j].db})</td></tr>`;
      }
    }
    const table = `<table><tr><th colspan="1" rowspan="2">Service</th> <th colspan="3">Application</th> <th colspan="2">DataBase</th></tr>
    <tr><th>Cluster</th> <th>Service</th><th>Status</th><th>Package</th><th>Status</th></tr>${rows}</table>`
    const body = `<body><p>Hi Team,</p><p>Please find below the deployment status and the attached logs of ${deployedUnit}.</p>${table} <p>Regards,</br>DevOps Team</p></body>`;
    const EMAIL_BODY_HTML = `<html>${head}${body}<html>`;

    logger.info(`File content : ${fileContent}`);
    const attachment = {
      filename: "deployment_log.txt",
      content: fileContent,
      contentType: "text/plain"
    }

    const params = {
      from: SENDER_EMAIL,
      to: RECIPIENT_EMAIL,
      cc: RECIPIENT_EMAIL_CC,
      subject: EMAIL_SUBJECT,
      htmlBody: EMAIL_BODY_HTML,
      attachment: attachment
    };
    sendEmailWithAttachment(params);

  } catch (error) {
    logger.error(`Error while sending mail ${error.message}`, error.stack);
  }
}


