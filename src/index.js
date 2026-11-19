
const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

const WORKSPACE = path.resolve(__dirname, "../workspace");

function safeProjectName(name) {
    return String(name)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50) || "generated-app";
}

function createCapStudentFiles() {
    return {
        "package.json": JSON.stringify({
            name: "student-management-app",
            version: "1.0.0",
            private: true,
            description: "Student Management Application using SAP CAP",
            scripts: {
                start: "cds-serve",
                watch: "cds watch",
                test: "node --check srv/server.js"
            },
            dependencies: {
                "@sap/cds": "^9.9.3",
                "@cap-js/sqlite": "^2"
            },
            devDependencies: {}
        }, null, 2),

        "db/schema.cds": `
namespace student.management;

entity Students {
    key ID : UUID;
    name   : String(100) not null;
    email  : String(150) not null;
    course : String(100);
}
`,

        "srv/student-service.cds": `
using student.management as db from '../db/schema';

service StudentService {
    entity Students as projection on db.Students;
}
`,

        "srv/server.js": `
const cds = require("@sap/cds");
const express = require("express");
const path = require("node:path");

cds.on("bootstrap", app => {
    app.use("/ui", express.static(path.join(__dirname, "../app")));
});

module.exports = cds.server;
`,

        "app/index.html": `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Student Management</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 900px;
            margin: 40px auto;
            padding: 20px;
            background: #f4f6f9;
        }
        h1 { color: #17365d; }
        form, .panel {
            background: white;
            padding: 20px;
            margin-bottom: 20px;
            border-radius: 8px;
        }
        input {
            padding: 10px;
            margin: 5px;
            width: 25%;
            box-sizing: border-box;
        }
        button {
            padding: 10px 15px;
            margin: 5px;
            cursor: pointer;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            background: white;
        }
        th, td {
            padding: 12px;
            border: 1px solid #ddd;
            text-align: left;
        }
        th { background: #17365d; color: white; }
        #message { margin: 12px 0; }
    </style>
</head>
<body>
    <h1>Student Management</h1>

    <section class="panel">
        <h2 id="formTitle">Register Student</h2>
        <form id="studentForm">
            <input id="name" placeholder="Student name" required>
            <input id="email" type="email" placeholder="Email" required>
            <input id="course" placeholder="Course">
            <button type="submit">Save Student</button>
            <button type="button" onclick="resetForm()">Clear</button>
        </form>
        <p id="message"></p>
    </section>

    <section class="panel">
        <h2>Student List</h2>
        <button onclick="loadStudents()">Refresh</button>
        <table>
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Course</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody id="studentList"></tbody>
        </table>
    </section>

    <script>
        const API = "/odata/v4/student/Students";
        let editingId = null;

        async function request(url, options = {}) {
            const response = await fetch(url, {
                ...options,
                headers: {
                    "Content-Type": "application/json",
                    ...options.headers
                }
            });

            if (!response.ok) {
                throw new Error(await response.text());
            }

            if (response.status === 204) return null;
            return response.json();
        }

        async function loadStudents() {
            try {
                const result = await request(API);
                const students = result.value || [];
                const list = document.getElementById("studentList");

                list.replaceChildren();

                students.forEach(student => {
                    const row = document.createElement("tr");

                    [student.name, student.email, student.course || ""]
                        .forEach(value => {
                            const cell = document.createElement("td");
                            cell.textContent = value;
                            row.appendChild(cell);
                        });

                    const actions = document.createElement("td");

                    const edit = document.createElement("button");
                    edit.textContent = "Edit";
                    edit.onclick = () => editStudent(student);

                    const remove = document.createElement("button");
                    remove.textContent = "Delete";
                    remove.onclick = () => deleteStudent(student.ID);

                    actions.append(edit, remove);
                    row.appendChild(actions);
                    list.appendChild(row);
                });
            } catch (error) {
                showMessage("Unable to load students: " + error.message);
            }
        }

        document.getElementById("studentForm").addEventListener(
            "submit",
            async event => {
                event.preventDefault();

                const student = {
                    name: document.getElementById("name").value.trim(),
                    email: document.getElementById("email").value.trim(),
                    course: document.getElementById("course").value.trim()
                };

                try {
                    if (editingId) {
                        await request(
                            API + "(" + editingId + ")",
                            {
                                method: "PATCH",
                                body: JSON.stringify(student)
                            }
                        );
                    } else {
                        await request(API, {
                            method: "POST",
                            body: JSON.stringify(student)
                        });
                    }

                    showMessage("Student saved successfully.");
                    resetForm();
                    await loadStudents();
                } catch (error) {
                    showMessage("Save failed: " + error.message);
                }
            }
        );

        function editStudent(student) {
            editingId = student.ID;
            document.getElementById("name").value = student.name;
            document.getElementById("email").value = student.email;
            document.getElementById("course").value = student.course || "";
            document.getElementById("formTitle").textContent = "Update Student";
        }

        async function deleteStudent(id) {
            if (!confirm("Delete this student?")) return;

            try {
                await request(API + "(" + id + ")", {
                    method: "DELETE"
                });
                showMessage("Student deleted.");
                await loadStudents();
            } catch (error) {
                showMessage("Delete failed: " + error.message);
            }
        }

        function resetForm() {
            editingId = null;
            document.getElementById("studentForm").reset();
            document.getElementById("formTitle").textContent = "Register Student";
        }

        function showMessage(message) {
            document.getElementById("message").textContent = message;
        }

        loadStudents();
    </script>
</body>
</html>
`,

        "README.md": `
# Student Management App

A student management application built using SAP CAP, Node.js and SQLite.

## Features

- Register students
- List students
- Update student details
- Delete students
- SQLite database
- Browser-based user interface

## Run locally

Install dependencies:

    npm install

Start the development server:

    npm run watch

Open the application:

    http://localhost:4004/ui/
    
OData service:

    http://localhost:4004/odata/v4/student/Students
`
    };
}

async function createCapProject(userPrompt) {
    const projectName = safeProjectName("student-management-app");
    const projectDir = path.join(WORKSPACE, projectName);

    try {
        await fs.access(projectDir);
        throw new Error(
            `Project already exists: ${projectDir}. Rename or move it before generating again.`
        );
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    console.log("\n[1/3] Preparing SAP CAP project architecture...");

    const files = createCapStudentFiles();
    const entries = Object.entries(files);

    await fs.mkdir(projectDir, { recursive: true });

    console.log(`\n[2/3] Creating ${entries.length} project files...\n`);

    for (const [relativePath, content] of entries) {
        const destination = path.resolve(projectDir, relativePath);

        if (!destination.startsWith(projectDir + path.sep)) {
            throw new Error("Unsafe file path detected.");
        }

        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, content.trimStart() + "\n", "utf8");

        console.log("Created:", relativePath);
    }

    await fs.writeFile(
        path.join(projectDir, "generation-request.txt"),
        userPrompt + "\n",
        "utf8"
    );

    console.log("\n[3/3] Project generation completed.");
    console.log("\nProject location:", projectDir);
    console.log("\nNext step: install dependencies and test the project.");
}

async function main() {
    await fs.mkdir(WORKSPACE, { recursive: true });

    const rl = readline.createInterface({ input: stdin, output: stdout });

    console.log("\n========================================");
    console.log("       AUTONOMOUS AI APP BUILDER");
    console.log("========================================");
    console.log("Model: Qwen 2.5 Coder 3B");
    console.log("Workspace: " + WORKSPACE);

    try {
        const prompt = await rl.question(
            "\nDescribe the application you want to build:\n> "
        );

        if (!prompt.trim()) {
            console.log("Please enter an application description.");
            return;
        }

        const isCapStudentApp =
            /sap\s*cap|cloud application programming model/i.test(prompt) &&
            /student/i.test(prompt);

        if (isCapStudentApp) {
            await createCapProject(prompt);
        } else {
            console.log(
                "\nCurrently, this version supports SAP CAP Student Management generation."
            );
            console.log(
                "We will add more application templates in the next version."
            );
        }
    } catch (error) {
        console.error("\nAgent error:", error.message);
    } finally {
        rl.close();
    }
}

main();
