import { GetObjectCommand, PutObjectCommand ,CopyObjectCommand} from "@aws-sdk/client-s3";
import yaml from "js-yaml";
import { Upload } from "@aws-sdk/lib-storage";
import fs from "fs";
const region = process.env.AWS_REGION || "us-east-1";
import { pipeline } from "stream/promises";
import path from "path";
import { getAsyncContextLogger } from '../../utils/logger.js';
import { s3Client } from '../../utils/awsClients.js';

// Function to read YAML file from S3 bucket and convert it to JSON
export async function readYamlFromS3(bucketName, key) {
  const logger = getAsyncContextLogger();
  try {
    const params = {
      Bucket: bucketName,
      Key: key
    };
    logger.info(`Reading YAML from S3 - Bucket: ${bucketName}, Key: ${key}`);
    logger.info(key);
    logger.info(bucketName);
    logger.info(region);

    const command = new GetObjectCommand(params);
    const data = await s3Client.send(command);
    const yamlData = await data.Body.transformToString();
    const jsonObject = yaml.load(yamlData);
    return jsonObject;
  } catch (e) {
    logger.error(`${e.message} : ${e.stack}`);
    throw e;
  }
}

export async function downloadFromS3(bucketName, objectKey, downloadPath) {
  const logger = getAsyncContextLogger();
  logger.info(`Attempting to download s3://${bucketName}/${objectKey} to ${downloadPath} ...`);

  const getObjectParams = {
      Bucket: bucketName,
      Key: objectKey,
  };

  try {
      // Create the GetObject command
      const command = new GetObjectCommand(getObjectParams);

      // Send the command to S3 to retrieve the object
      const response = await s3Client.send(command);

      // Check if the response body exists and is a readable stream
      if (!response.Body || typeof response.Body.pipe !== 'function') {
          throw new Error("Invalid response body received from S3.");
      }

      // Create a writable stream to save the file locally
      // Ensure the directory exists before creating the write stream if necessary
      const localFilePath = path.resolve(downloadPath); // Ensure absolute path
      const fileStream = fs.createWriteStream(localFilePath);

      logger.info(`Streaming download to ${localFilePath}...`);

      // Use pipeline to efficiently pipe the S3 object stream to the local file stream.
      // pipeline handles errors and stream cleanup automatically.
      await pipeline(response.Body, fileStream);

      logger.info(`Successfully downloaded s3://${bucketName}/${objectKey} to ${localFilePath}`);

  } catch (error) {
      logger.error(`Error downloading file from S3: ${error.message}`, error.stack);
      // Rethrow the error for the caller to handle if needed
      throw error;
  }
}

export async function writeFileToS3(bucketName, key, filePath) {
  const logger = getAsyncContextLogger();
  try {
    const fileStream = fs.createReadStream(filePath);
    const uploadParams = {
      Bucket: bucketName,
      Key: key,
      Body: fileStream,
    };

    const upload = new Upload({
      client: s3Client,
      params: uploadParams,
    });

    upload.on("httpUploadProgress", (progress) => {
      logger.info(`Uploaded ${progress.loaded} of ${progress.total} bytes`);
    });

    await upload.done();
    logger.info("File uploaded successfully.");
  } catch (err) {
    logger.error(`Error uploading file: ${err.message}`, err.stack);
  }
}

export async function changePath(bucketName, sourceKey, destinationKey) {
  const logger = getAsyncContextLogger();
  const copyParams = {
    CopySource: `${bucketName}/${sourceKey}`,
    Bucket: bucketName,
    Key: destinationKey,
  };

  logger.info(`Copy file within S3 :${JSON.stringify(copyParams)}`);

  // Create the command
  const copyCommand = new CopyObjectCommand(copyParams);

  // Function to copy the object
  try {
    const data = await s3Client.send(copyCommand);
    logger.info(`Success, object copied: ${JSON.stringify(data)}`);
  } catch (err) {
    logger.error(`Error copying object: ${err.message}`, err.stack);
  }
}