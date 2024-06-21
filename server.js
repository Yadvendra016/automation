const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const Mailgun = require("mailgun.js");
const axios = require("axios");
const formData = require("form-data");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const mongoose = require("mongoose");
const Contact = require("./models/contact");

const app = express();
const port = 8080;

app.use(cors());
app.use(bodyParser.json());

// connect mongodb
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.log(err));

const mailgun = new Mailgun(formData);
const mg = mailgun.client({
  username: "api",
  key: process.env.MAILGUN_API_KEY,
});

const MESSENGER_BACKEND_URL = "https://reachify.onrender.com";

let emailEventStates = {};
let workflowStates = {};

async function sendMessengerMessage(message) {
  try {
    const usersResponse = await axios.get(`${MESSENGER_BACKEND_URL}/getUsers`);
    const users = usersResponse.data;

    for (const user of users) {
      const payload = {
        platform: "messenger",
        recipientId: user.clientId,
        messageText: message,
      };
      await axios.post(`${MESSENGER_BACKEND_URL}/send`, payload);
    }
  } catch (error) {
    console.error("Error sending Messenger message:", error);
    throw error;
  }
}

async function processFindContactStep(step, workflowState) {
  const { criteria } = step;

  // Build the query based on the criteria
  const query = {};
  criteria.forEach(({ field, value }) => {
    query[field] = value;
  });

  try {
    const contact = await Contact.findOne(query);

    if (contact) {
      console.log(`Contact found: ${JSON.stringify(contact)}`);
    } else {
      console.log("Contact not found, stopping workflow");
      workflowState.stopped = true;
    }
  } catch (error) {
    console.error("Error finding contact:", error);
    throw error;
  }
}

app.post("/api/emailWorkflow", async (req, res) => {
  const { senderEmail, senderName, workflow } = req.body;
  const workflowId = new Date().getTime();

  workflowStates[workflowId] = {
    workflowId,
    senderEmail,
    senderName,
    steps: JSON.parse(workflow),
    currentStepIndex: 0,
    stopped: false,
  };

  console.log();
  console.log(`New workflow received with ID: ${workflowId}`);
  console.log(`Sender Email: ${senderEmail}, Sender Name: ${senderName}`);
  console.log("Workflow steps:", workflowStates[workflowId].steps);

  try {
    await processNextWorkflowStep(workflowId);
    res.status(200).send({ message: "Workflow submitted successfully" });
  } catch (err) {
    console.error("Error processing workflow", err);
    res.status(500).send({ message: "Error processing workflow" });
  }
});

async function processNextWorkflowStep(workflowId) {
  const workflowState = workflowStates[workflowId];

  if (workflowState.stopped) {
    console.log();
    console.log(`Workflow ID: ${workflowId} has been stopped`);
    return;
  }

  const step = workflowState.steps[workflowState.currentStepIndex];

  if (!step) {
    console.log();
    console.log(`No more steps in workflow ID: ${workflowId}`);
    return;
  }

  console.log();
  console.log(
    `Processing step index ${workflowState.currentStepIndex} for workflow ID: ${workflowId}`
  );
  console.log("Step details:", step);

  await processWorkflowStep(step, workflowState);

  if (workflowState.stopped) {
    console.log();
    console.log(
      `Workflow ID: ${workflowId} has been stopped after step processing`
    );
    return;
  }

  workflowState.currentStepIndex += 1;

  console.log();
  console.log(`Moving to next step in workflow ID: ${workflowId}`);

  processNextWorkflowStep(workflowId);
}

async function processWorkflowStep(step, workflowState) {
  if (step.type === "email") {
    const { to, subject, message, template } = step;
    let emailHtml = "";

    if (template) {
      try {
        const templatePath = path.join(
          __dirname,
          "templates",
          `${template}.html`
        );
        emailHtml = fs.readFileSync(templatePath, "utf-8");
      } catch (err) {
        console.error(`Error reading template: ${template}`, err);
        throw err;
      }
    } else {
      emailHtml = message;
    }

    if (!emailHtml) {
      console.error("No email content provided");
      throw new Error("No email content provided");
    }

    const emailInfo = {
      from: `${workflowState.senderName} <${workflowState.senderEmail}>`,
      to: [to],
      subject: subject,
      html: emailHtml,
      "o:tracking": true,
      "o:tracking-opens": true,
    };

    if (!emailEventStates[to]) {
      emailEventStates[to] = {};
    }

    console.log();
    console.log("Sending email with details:", emailInfo);

    try {
      await sendEmail(emailInfo);
      console.log();
      console.log("Email sent successfully");
    } catch (err) {
      console.error("Error sending email:", err);
      throw err;
    }
  } else if (step.type === "timeBreak") {
    const { duration } = step;

    console.log();
    console.log(`Taking a break for ${duration} milliseconds`);

    await new Promise((resolve) => setTimeout(resolve, duration));

    console.log();
    console.log("Break ended");
  } else if (step.type === "conditional") {
    const { condition, truePath, falsePath } = step;
    let conditionResult = false;

    console.log();
    console.log(`Evaluating condition: ${condition}`);

    try {
      conditionResult = eval(condition);
      console.log();
      console.log(`Condition result: ${conditionResult}`);
    } catch (error) {
      console.error(`Error evaluating condition: ${condition}`, error);
      throw error;
    }

    if (conditionResult) {
      console.log();
      console.log("Condition is true, following truePath");

      workflowState.steps.splice(
        workflowState.currentStepIndex + 1,
        0,
        ...truePath
      );
    } else {
      console.log();
      console.log("Condition is false, following falsePath");

      workflowState.steps.splice(
        workflowState.currentStepIndex + 1,
        0,
        ...falsePath
      );
    }
  } else if (step.type === "messenger") {
    const { message } = step;
    await sendMessengerMessage(message);
  } else if (step.type === "split") {
    const { paths } = step;

    console.log();
    console.log("Splitting workflow paths");

    await Promise.all(
      paths.map(async (path) => {
        for (const pathStep of path) {
          await processWorkflowStep(pathStep, workflowState);
        }
      })
    );

    console.log();
    console.log("Completed processing split paths");
  } else if (step.type === "goto") {
    const { targetIndex } = step;

    console.log();
    console.log(`Going to step index: ${targetIndex}`);

    workflowState.currentStepIndex = targetIndex - 1;
  } else if (step.type === "stop") {
    console.log();
    console.log("Stop step encountered, halting workflow");
    workflowState.stopped = true; // Set stopped flag
    return;
  } else if (step.type === "createContact") {
    const { name, email, phone } = step.data;
    const { workflowId } = workflowState;

    try {
      let contact = await Contact.findOne({ email });

      if (!contact) {
        // Create new contact if it does not exist
        contact = new Contact({ name, email, phone, workflowId });
        await contact.save();
        console.log(`Contact created successfully: ${email}`);
      } else {
        // Update existing contact with any changes
        contact.name = name || contact.name;
        contact.phone = phone || contact.phone;
        contact.workflowId = workflowId;
        await contact.save();
        console.log(`Contact updated successfully: ${email}`);
      }

      console.log(`Contact created/updated successfully: ${email}`);
    } catch (error) {
      console.error("Error creating/updating contact:", error);
      throw error;
    }
  } else if (step.type === "deleteContact") {
    const { workflowId } = workflowState;

    try {
      await Contact.deleteMany({ workflowId });
      console.log(`Contact deleted successfully: ${workflowId}`);
      // Ensure workflow is stopped after deletion
      workflowState.stopped = true;
    } catch (error) {
      console.error("Error deleting contact:", error);
      throw error;
    }
  } else if (step.type === "findContact") {
    await processFindContactStep(step, workflowState);
  } else if (step.type === "updateContact") {
    const { findCriteria, updateData } = step.data;
    const query = {};
    findCriteria.forEach((field) => {
      query[field.key] = field.value;
    });

    try {
      const contact = await Contact.findOne(query);
      if (!contact) {
        console.log("No contact found to update");
        workflowState.stopped = true;
      } else {
        for (const [key, value] of Object.entries(updateData)) {
          contact[key] = value;
        }
        await contact.save();
        console.log("Contact updated successfully");
      }
    } catch (error) {
      console.error("Error updating contact:", error);
      throw error;
    }
  }
}

function sendEmail(emailInfo) {
  return mg.messages.create(process.env.MAILGUN_DOMAIN, emailInfo);
}

app.post("/webhook/emailEvent", (req, res) => {
  const eventData = req.body["event-data"];
  const event = eventData.event;
  const recipient = eventData.recipient;

  console.log();
  console.log(`Received email event: ${event} for recipient: ${recipient}`);

  if (!emailEventStates[recipient]) {
    emailEventStates[recipient] = {};
  }

  if (event === "clicked") {
    emailEventStates[recipient].clicked = true;
    triggerWorkflowForEmailClicked(recipient);
  } else if (event === "opened") {
    emailEventStates[recipient].opened = true;
    console.log("");
    console.log("Email opened");
    triggerWorkflowForEmailOpened(recipient);
  }

  res.status(200).send({ message: "Event received" });
});

function triggerWorkflowForEmailOpened(recipient) {
  console.log("");
  console.log("in the function triggerWOrkflowopen");
  for (const workflowId in workflowStates) {
    const workflowState = workflowStates[workflowId];
    const step = workflowState.steps[workflowState.currentStepIndex];
    console.log("entererd in the triggerWorkflowEmail opened");
    console.log("");
    console.log(step);
    if (
      step &&
      step.type === "conditional" &&
      step.condition.includes(`emailEventStates['${recipient}'].opened`)
    ) {
      console.log("");
      console.log(
        `Triggering workflow ID: ${workflowId} for email opened by: ${recipient}`
      );

      processNextWorkflowStep(workflowId);
    }
  }
}

function triggerWorkflowForEmailClicked(recipient) {
  console.log();
  console.log("Triggering workflow for email clicked");

  for (const workflowId in workflowStates) {
    const workflowState = workflowStates[workflowId];
    const step = workflowState.steps[workflowState.currentStepIndex];

    if (
      step &&
      step.type === "conditional" &&
      step.condition.includes(`emailEventStates['${recipient}'].clicked`)
    ) {
      console.log();
      console.log(
        `Triggering workflow ID: ${workflowId} for email clicked by: ${recipient}`
      );

      processNextWorkflowStep(workflowId);
    }
  }
}

app.get("/api/templates", (req, res) => {
  const templatesDir = path.join(__dirname, "templates");
  fs.readdir(templatesDir, (err, files) => {
    if (err) {
      console.error("Error reading templates directory:", err);
      return res.status(500).send({ message: "Error reading templates" });
    }

    const templates = files.map((file) => path.parse(file).name);
    res.status(200).send({ templates });
  });
});

// handle form submission
app.post("/api/createContact", async (req, res) => {
  const { name, email, phone } = req.body;
  console.log(
    `Form is submitted by ${name} with email ${email} and phone number: ${phone}`
  );

  try {
    let contact = await Contact.findOne({ email });

    if (!contact) {
      contact = new Contact({ name, email, phone });
      await contact.save();
    }

    res
      .status(200)
      .send({ message: "Contact created/updated successfully", contact });
  } catch (error) {
    console.error("Error creating/updating contact:", error);
    res.status(500).send({ message: "Error creating/updating contact" });
  }
});

app.listen(port, () => {
  console.log();
  console.log(`Server running on http://localhost:${port}`);
});
