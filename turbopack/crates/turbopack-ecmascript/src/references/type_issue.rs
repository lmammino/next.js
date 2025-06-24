use turbo_rcstr::rcstr;
use turbo_tasks::Vc;
use turbo_tasks_fs::FileSystemPath;
use turbopack_core::issue::{
    Issue, IssueSeverity, IssueSource, IssueStage, OptionStyledString, StyledString,
};

use crate::SpecifiedModuleType;

#[turbo_tasks::value(shared)]
pub struct SpecifiedModuleTypeIssue {
    pub source: IssueSource,
    pub specified_type: SpecifiedModuleType,
}

#[turbo_tasks::value_impl]
impl Issue for SpecifiedModuleTypeIssue {
    #[turbo_tasks::function]
    fn file_path(&self) -> Vc<FileSystemPath> {
        self.source.file_path()
    }

    #[turbo_tasks::function]
    fn title(&self) -> Vc<StyledString> {
        StyledString::Text(match self.specified_type {
            SpecifiedModuleType::CommonJs => rcstr!(
                "Specified module format (CommonJs) is not matching the module format of the \
                 source code (EcmaScript Modules)"
            ),
            SpecifiedModuleType::EcmaScript => rcstr!(
                "Specified module format (EcmaScript Modules) is not matching the module format \
                 of the source code (CommonJs)"
            ),
            SpecifiedModuleType::Automatic => rcstr!(
                "Specified module format is not matching the module format of the source code"
            ),
        })
        .cell()
    }

    #[turbo_tasks::function]
    fn description(&self) -> Vc<OptionStyledString> {
        Vc::cell(Some(
            StyledString::Text(match self.specified_type {
                SpecifiedModuleType::CommonJs => {
                    rcstr!(
                        "The CommonJs module format was specified in the package.json that is \
                         affecting this source file or by using an special extension, but \
                         Ecmascript import/export syntax is used in the source code.\nThe module \
                         was automatically converted to an EcmaScript module, but that is in \
                         conflict with the specified module format. Either change the \"type\" \
                         field in the package.json or replace EcmaScript import/export syntax \
                         with CommonJs syntas in the source file.\nIn some cases EcmaScript \
                         import/export syntax is added by an transform and isn't actually part of \
                         the source code. In these cases revisit transformation options to inject \
                         the correct syntax."
                    )
                }
                SpecifiedModuleType::EcmaScript => {
                    rcstr!(
                        "The EcmaScript module format was specified in the package.json that is \
                         affecting this source file or by using an special extension, but it \
                         looks like that CommonJs syntax is used in the source code.\nExports \
                         made by CommonJs syntax will lead to a runtime error, since the module \
                         is in EcmaScript mode. Either change the \"type\" field in the \
                         package.json or replace CommonJs syntax with EcmaScript import/export \
                         syntax in the source file."
                    )
                }
                SpecifiedModuleType::Automatic => rcstr!(
                    "The module format specified in the package.json file is not matching the \
                     module format of the source code."
                ),
            })
            .resolved_cell(),
        ))
    }

    fn severity(&self) -> IssueSeverity {
        match self.specified_type {
            SpecifiedModuleType::CommonJs => IssueSeverity::Error,
            SpecifiedModuleType::EcmaScript => IssueSeverity::Warning,
            SpecifiedModuleType::Automatic => IssueSeverity::Hint,
        }
    }

    #[turbo_tasks::function]
    fn stage(&self) -> Vc<IssueStage> {
        IssueStage::Analysis.into()
    }

    fn source(&self) -> Option<&IssueSource> {
        Some(&self.source)
    }
}
