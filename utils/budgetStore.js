const fs = require("fs");

const FILE = "./budgets.json";

// CREATE FILE IF MISSING

if (!fs.existsSync(FILE)) {

  fs.writeFileSync(
    FILE,
    JSON.stringify({}, null, 2)
  );

}

// LOAD DB

function loadBudgets() {

  return JSON.parse(
    fs.readFileSync(FILE, "utf8")
  );

}

// SAVE DB

function saveBudgets(data) {

  fs.writeFileSync(
    FILE,
    JSON.stringify(data, null, 2)
  );

}

// GET CUSTOMER

function getCustomerBudget(customerId) {

  const db = loadBudgets();

  if (!db[customerId]) {

    db[customerId] = {

      monthlySpend: 0,

      budgetLimit: 0.05,

      downgradeCount: 0

    };

    saveBudgets(db);

  }

  return db[customerId];

}

// ADD SPEND

function addSpend(customerId, amount) {

  const db = loadBudgets();

  if (!db[customerId]) {

    db[customerId] = {

      monthlySpend: 0,

      budgetLimit: 0.05,

      downgradeCount: 0

    };

  }

  db[customerId].monthlySpend += amount;

  saveBudgets(db);

}

// CHECK LIMIT

function budgetExceeded(customerId) {

  const customer =
    getCustomerBudget(customerId);

  return (
    customer.monthlySpend >=
    customer.budgetLimit
  );

}

// TRACK DOWNGRADE

function incrementDowngrade(customerId) {

  const db = loadBudgets();

  if (!db[customerId]) return;

  db[customerId].downgradeCount++;

  saveBudgets(db);

}

module.exports = {

  getCustomerBudget,
  addSpend,
  budgetExceeded,
  incrementDowngrade

};