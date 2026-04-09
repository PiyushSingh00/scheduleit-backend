router.get("/tournaments", auth, async (req, res) => {
  if (req.user.role !== "host") {
    return res.status(403).json({ message: "Not a host" });
  }

  const params = {
    TableName: "ScheduleItTournaments",
    IndexName: "hostUsername-index",
    KeyConditionExpression: "hostUsername = :h",
    ExpressionAttributeValues: {
      ":h": req.user.username
    }
  };

  const data = await dynamo.query(params).promise();
  res.json(data.Items);
});
