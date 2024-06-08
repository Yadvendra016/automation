const { createMachine, interpret, assign } = require("xstate");

const emailMachine = createMachine(
  {
    id: "emailWorkflow",
    initial: "start",
    context: {
      senderEmail: "",
      senderName: "",
      workflow: [],
      attachments: [],
      currentStepIndex: 0,
    },
    states: {
      start: {
        entry: ["startWorkflow"],
      },
      emailStep: {
        invoke: {
          src: "sendEmailStep",
          onDone: {
            target: "timeBreakStep",
            actions: ["incrementStepIndex"],
          },
        },
      },
      timeBreakStep: {
        invoke: {
          src: "timeBreakStep",
          onDone: {
            target: "emailStep",
            actions: ["incrementStepIndex"],
          },
        },
      },
      end: {
        type: "final",
      },
    },
  },
  {
    actions: {
      startWorkflow: assign({
        senderEmail: (_, event) => event.senderEmail,
        senderName: (_, event) => event.senderName,
        workflow: (_, event) => event.workflow,
        attachments: (_, event) => event.attachments,
      }),
      incrementStepIndex: assign({
        currentStepIndex: (context) => context.currentStepIndex + 1,
      }),
    },
    services: {
      sendEmailStep: (context) => {
        const step = context.workflow[context.currentStepIndex];
        const { to, subject, message } = step;
        const emailInfo = {
          from: `${context.senderName} <${context.senderEmail}>`,
          to: [to],
          subject: subject,
          html: message,
          attachment: context.attachments.map((file) =>
            fs.createReadStream(file.path)
          ),
        };
        return sendEmail(emailInfo);
      },
      timeBreakStep: (context) => {
        return new Promise((resolve) =>
          setTimeout(
            resolve,
            context.workflow[context.currentStepIndex].duration
          )
        );
      },
    },
  }
);

module.exports = emailMachine;
