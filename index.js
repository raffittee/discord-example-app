const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  PermissionsBitField,
} = require("discord.js");
const mongoose = require("mongoose");
require("dotenv").config();

// MongoDB connection URI
const MONGO_URI = process.env.MONGO_URI;

// Define a Mongoose schema for teams
const teamSchema = new mongoose.Schema({
  name: String,
  creatorId: String,
  status: { type: String, default: "pending" }, // 'pending', 'approved', 'rejected'
});

const Team = mongoose.model("Team", teamSchema, "Teams");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel],
});

// Replace with your bot's token
const TOKEN = process.env.TOKEN;
// Replace with your admin/mod channel ID
const ADMIN_CHANNEL_ID = "1270444263175487614";

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  // Connect to MongoDB
  try {
    await mongoose.connect(MONGO_URI);
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("Error connecting to MongoDB", error);
  }
});

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  const clientRole = newMember.guild.roles.cache.find(
    (role) => role.name === "Client"
  ); // Replace with your client role name
  if (
    clientRole &&
    !oldMember.roles.cache.has(clientRole.id) &&
    newMember.roles.cache.has(clientRole.id)
  ) {
    await createTicket(newMember);
  }
});

async function createTicket(member) {
  const embed = new EmbedBuilder()
    .setTitle("Client Ticket")
    .setDescription(
      "If you are a client that wants to create a new group, click 'Create Team'.\n" +
        "If you are a client that wants to join a team, click 'Join Team'.\n" +
        "If you clicked it by accident, click 'Ignore'.\n\n" +
        "**Warning:** Joining a team that you are not involved will result in a warning. Continuous acts will result in a ban."
    )
    .setColor(Colors.Blue);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("create_team")
      .setLabel("Create Team")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("join_team")
      .setLabel("Join Team")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ignore")
      .setLabel("Ignore")
      .setStyle(ButtonStyle.Danger)
  );

  try {
    await member.send({ embeds: [embed], components: [row] });
  } catch (error) {
    console.error(`Could not send DM to ${member.user.tag}.\n`, error);
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  try {
    // Defer the reply to acknowledge the interaction
    await interaction.deferReply();

    // Handle create_team button click
    if (interaction.customId === "create_team") {
      await interaction.followUp({
        content: "Please provide a team name",
        ephemeral: true,
      });

      const filter = (response) => response.author.id === interaction.user.id;
      const collector = interaction.channel.createMessageCollector({
        filter,
        time: 60000, // 60 seconds to respond
      });

      collector.on("collect", async (msg) => {
        const teamName = msg.content.trim();
        if (teamName) {
          const newTeam = new Team({
            name: teamName,
            creatorId: interaction.user.id,
          });
          await newTeam.save();

          // Notify admins
          const adminChannel = client.channels.cache.get(ADMIN_CHANNEL_ID);
          if (adminChannel) {
            const embed = new EmbedBuilder()
              .setTitle("New Team Request")
              .setDescription(
                `User ${interaction.user.tag} (${interaction.user.id}) has requested to create a team named "${teamName}".\n\nClick the buttons below to approve or reject.`
              )
              .setColor(Colors.Yellow);

            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`approve_${teamName}`)
                .setLabel("Approve")
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`reject_${teamName}`)
                .setLabel("Reject")
                .setStyle(ButtonStyle.Danger)
            );

            await adminChannel.send({ embeds: [embed], components: [row] });
          }

          await interaction.editReply({
            content: `Team "${teamName}" has been submitted for approval.`,
          });
          collector.stop(); // Stop collecting after receiving the team name
        }
      });

      collector.on("end", (collected) => {
        if (collected.size === 0) {
          interaction.editReply({
            content: "No team name provided. Ticket ignored.",
          });
        }
      });
    }
    // Handle approve or reject button clicks
    else if (
      (interaction.customId.startsWith("approve_") &&
        !interaction.customId.startsWith("approve_join")) ||
      (interaction.customId.startsWith("reject_") &&
        !interaction.customId.startsWith("reject_join"))
    ) {
      console.log(interaction.customId);
      const teamName = interaction.customId.split("_").slice(1).join("_");
      const action = interaction.customId.startsWith("approve_")
        ? "approved"
        : "rejected";

      try {
        // Check if the team exists and is not already processed
        const result = await Team.updateOne(
          { name: teamName },
          { status: action }
        );

        if (result.matchedCount === 0) {
          throw new Error(`Team "${teamName}" not found.`);
        }
        if (result.modifiedCount === 0) {
          throw new Error(`Team "${teamName}" has already been processed.`);
        }

        const team = await Team.findOne({ name: teamName }).exec();
        if (!team) {
          throw new Error(`Team "${teamName}" not found.`);
        }

        if (action === "approved") {
          await createCategoryAndChannels(teamName, team.creatorId);
        }

        await interaction.editReply({
          content: `Team "${teamName}" has been ${action}.`,
        });

        await notifyAdmins(
          interaction.user,
          `has ${action} the team creation request for "${teamName}".`
        );
      } catch (error) {
        console.error("Error handling approval/rejection:", error);
        await interaction.editReply({
          content: `There was an error processing the request for team "${teamName}": ${error.message}`,
        });
      }
    }
    // Handle join_team button click
    else if (interaction.customId === "join_team") {
      try {
        const teamsList = await Team.find({ status: "approved" }).exec();
        if (teamsList.length > 0) {
          const embed = new EmbedBuilder()
            .setTitle("Available Teams")
            .setDescription(
              teamsList.map((team) => `- ${team.name}`).join("\n")
            )
            .setColor(Colors.Green);

          await interaction.followUp({
            content: "Please provide the name of the team you want to join.",
            ephemeral: true,
            embeds: [embed],
          });

          const filter = (response) =>
            response.author.id === interaction.user.id;
          const collector = interaction.channel.createMessageCollector({
            filter,
            time: 60000, // 60 seconds to respond
          });

          collector.on("collect", async (msg) => {
            const teamName = msg.content.trim();
            const team = await Team.findOne({
              name: teamName,
              status: "approved",
            }).exec();
            if (team) {
              // Notify admins for approval
              const adminChannel = client.channels.cache.get(ADMIN_CHANNEL_ID);
              if (adminChannel) {
                const embed = new EmbedBuilder()
                  .setTitle("Join Team Request")
                  .setDescription(
                    `User ${interaction.user.tag} has requested to join the team "${teamName}".\n\nClick the buttons below to approve or reject.`
                  )
                  .setColor(Colors.Orange);

                const row = new ActionRowBuilder().addComponents(
                  new ButtonBuilder()
                    .setCustomId(
                      `approve_join_${teamName}_${interaction.user.id}`
                    )
                    .setLabel("Approve")
                    .setStyle(ButtonStyle.Success),
                  new ButtonBuilder()
                    .setCustomId(
                      `reject_join_${teamName}_${interaction.user.id}`
                    )
                    .setLabel("Reject")
                    .setStyle(ButtonStyle.Danger)
                );

                await adminChannel.send({ embeds: [embed], components: [row] });
              }

              await interaction.followUp({
                content: `Your request to join team "${teamName}" has been submitted for approval.`,
                ephemeral: true,
              });
              collector.stop(); // Stop collecting after receiving the team name
            } else {
              await interaction.followUp({
                content: `The team "${teamName}" does not exist or is not approved.`,
                ephemeral: true,
              });
            }
          });

          collector.on("end", (collected) => {
            if (collected.size === 0) {
              interaction.followUp({
                content: "No team name provided. Request ignored.",
                ephemeral: true,
              });
            }
          });
        } else {
          await interaction.followUp({
            content: "No teams available to join.",
            ephemeral: true,
          });
        }
      } catch (error) {
        console.error("Error retrieving teams:", error);
        await interaction.followUp({
          content: "There was an error retrieving the list of available teams.",
          ephemeral: true,
        });
      }
    }
    // Handle ignore button click
    else if (interaction.customId === "ignore") {
      await interaction.editReply({ content: "Ticket ignored." });
    }
    // Handle admin approval or rejection of join request
    else if (
      interaction.customId.startsWith("approve_join_") ||
      interaction.customId.startsWith("reject_join_")
    ) {
      const [approved, actionType, teamName, userId] = interaction.customId
        .split("_")
        .slice(0);
      const isApprove = approved === "approve";
      const actionText = isApprove ? "approved" : "rejected";

      try {
        if (isApprove) {
          const guild = client.guilds.cache.first(); // Modify if you have multiple guilds
          if (!guild) throw new Error("No guild found.");

          const teamRole = guild.roles.cache.find(
            (role) => role.name === teamName
          );
          if (!teamRole) throw new Error("Team role not found.");

          const member = guild.members.cache.get(userId);
          if (member) {
            await member.roles.add(teamRole);
            await interaction.editReply({
              content: `User ${member.user.tag} has been ${actionText} to join the team "${teamName}".`,
            });
          } else {
            await interaction.editReply({
              content: `User not found.`,
            });
          }
        } else {
          await interaction.editReply({
            content: `Join request for team "${teamName}" has been ${actionText}.`,
          });
        }
        await notifyAdmins(
          interaction.user,
          `has ${actionText} the join request for "${teamName}".`
        );
      } catch (error) {
        console.error("Error handling join request approval/rejection:", error);
        await interaction.editReply({
          content: `There was an error processing the join request for team "${teamName}": ${error.message}`,
        });
      }
    }
  } catch (error) {
    console.error("Unhandled error:", error);
    if (!interaction.replied) {
      await interaction.editReply({
        content: "An unexpected error occurred.",
      });
    }
  }
});

async function createCategoryAndChannels(teamName, creatorId) {
  const guild = client.guilds.cache.first(); // Modify if you have multiple guilds

  if (!guild) {
    console.error("No guild found.");
    return;
  }

  try {
    // Create Category
    const category = await guild.channels.create({
      name: teamName,
      type: 4, // Category type
    });

    // Define Channels with Icons
    const channels = [
      { name: "communication", icon: "💬" },
      { name: "meetings", icon: "📅" },
      { name: "notes", icon: "📝" },
      { name: "files", icon: "📁" },
      { name: "timeline-progress", icon: "📈" },
      { name: "payments", icon: "💸" },
    ];

    // Fetch roles
    const developerRole = guild.roles.cache.find(
      (role) => role.name === "Developer"
    );
    const modRole = guild.roles.cache.find((role) => role.name === "Mod");
    const teamRole = guild.roles.cache.find((role) => role.name === teamName);

    if (!developerRole || !modRole) {
      console.error("Required roles not found.");
      return;
    }

    // Create Channels under the Category
    for (const channel of channels) {
      let permissions = [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: developerRole.id,
          allow: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: modRole.id,
          allow: [PermissionsBitField.Flags.ViewChannel],
        },
      ];

      if (teamRole && channel.name !== "notes") {
        permissions.push({
          id: teamRole.id,
          allow: [PermissionsBitField.Flags.ViewChannel],
        });
      }

      await guild.channels.create({
        name: `${channel.icon} ${channel.name}`,
        type: channel.name === "meetings" ? 2 : 0, // 2 is for voice channels, 0 is for text channels
        parent: category.id,
        permissionOverwrites: permissions,
      });
    }

    // Create Role for the Team if not exists
    if (!teamRole) {
      await guild.roles.create({
        name: teamName,
        color: "#0000FF", // Customize color as needed
        reason: `Role for team ${teamName}`,
      });
    }

    // Assign Role to the User
    const member = guild.members.cache.get(creatorId);
    if (member) {
      const teamRole = guild.roles.cache.find((role) => role.name === teamName);
      if (teamRole) {
        await member.roles.add(teamRole);
      } else {
        console.error("Team role not found.");
      }
    } else {
      console.error("Member not found.");
    }
  } catch (error) {
    console.error("Error creating category and channels:", error);
  }
}

async function notifyAdmins(user, message) {
  const adminChannel = client.channels.cache.get(ADMIN_CHANNEL_ID);
  if (adminChannel) {
    const embed = new EmbedBuilder()
      .setTitle("Admin Notification")
      .setDescription(`${user.tag} ${message}`)
      .setColor(Colors.Red);

    await adminChannel.send({ embeds: [embed] });
  }
}

client.login(TOKEN);
