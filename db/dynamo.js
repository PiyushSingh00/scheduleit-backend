import AWS from "aws-sdk";

AWS.config.update({ region: "eu-north-1" });

export const dynamo = new AWS.DynamoDB.DocumentClient();
