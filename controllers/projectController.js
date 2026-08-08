const Project = require("../models/Project");
const Bot = require("../models/Bot");
const BotFile = require("../models/BotFile");

exports.createProject = async (req, res) => {
  try {
    const { name, description, commonBrandRules, allowedDomains } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Project / Brand name is required." });
    }

    const project = await Project.create({
      ownerId: req.user.id,
      userId: req.user.id,
      name: name.trim(),
      description: description ? description.trim() : "",
      commonBrandRules: commonBrandRules ? commonBrandRules.trim() : "",
      allowedDomains: Array.isArray(allowedDomains) ? allowedDomains : []
    });

    return res.status(201).json(project);
  } catch (err) {
    console.error("Create Project error:", err);
    return res.status(500).json({ error: "Failed to create Project." });
  }
};

exports.getProjects = async (req, res) => {
  try {
    const projects = await Project.find({
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    }).sort({ createdAt: -1 });

    const enrichedProjects = await Promise.all(
      projects.map(async (p) => {
        const botCount = await Bot.countDocuments({ projectId: p._id });
        const fileCount = await BotFile.countDocuments({ projectId: p._id });
        return {
          ...p.toObject(),
          botCount,
          fileCount
        };
      })
    );

    return res.json(enrichedProjects);
  } catch (err) {
    console.error("Get Projects error:", err);
    return res.status(500).json({ error: "Failed to fetch projects." });
  }
};

exports.getProjectById = async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await Project.findOne({
      _id: projectId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });

    if (!project) {
      return res.status(404).json({ error: "Project not found or unauthorized." });
    }

    const bots = await Bot.find({ projectId: project._id });
    const files = await BotFile.find({ projectId: project._id });

    return res.json({
      ...project.toObject(),
      bots,
      files
    });
  } catch (err) {
    console.error("Get Project By ID error:", err);
    return res.status(500).json({ error: "Failed to fetch project details." });
  }
};

exports.updateProject = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { name, description, commonBrandRules, allowedDomains } = req.body;

    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (description !== undefined) updateData.description = description.trim();
    if (commonBrandRules !== undefined) updateData.commonBrandRules = commonBrandRules.trim();
    if (allowedDomains !== undefined) updateData.allowedDomains = allowedDomains;

    const project = await Project.findOneAndUpdate(
      { _id: projectId, $or: [{ userId: req.user.id }, { ownerId: req.user.id }] },
      updateData,
      { new: true }
    );

    if (!project) {
      return res.status(404).json({ error: "Project not found or unauthorized." });
    }

    return res.json(project);
  } catch (err) {
    console.error("Update Project error:", err);
    return res.status(500).json({ error: "Failed to update project." });
  }
};
